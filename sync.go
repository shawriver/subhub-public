package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
)

// RevocationInfo is the post-hoc record of one revocation decision
// (gaps G2/G6): why the grant was cut, when, and the member numbers the
// decision was based on. Reason is one of quota | expired | manual |
// lease. Used/Limit are GB in the member quota口径 (cycle-aware Used).
type RevocationInfo struct {
	Reason  string  `json:"reason"`
	At      string  `json:"at"`
	Used    float64 `json:"used"`
	Limit   float64 `json:"limit"`
	Expires string  `json:"expires"`
}

// RestoreInfo stamps when a previously revoked grant became active
// again. It never clears LastRevocation: the pair reads as history.
type RestoreInfo struct {
	At string `json:"at"`
}

type Grant struct {
	ID        string `json:"id"`
	MemberID  string `json:"memberId"`
	NodeID    string `json:"nodeId"`
	PanelID   string `json:"panelId"`
	InboundID int    `json:"inboundId"`
	Email     string `json:"email"`
	Protocol  string `json:"protocol"`
	State     string `json:"state"`
	Error     string `json:"error"`
	LastSync  string `json:"lastSync"`
	LastUp    int64  `json:"lastUp"`
	LastDown  int64  `json:"lastDown"`
	Used      int64  `json:"used"`
	Lease     int64  `json:"lease"`
	Retired   bool   `json:"retired,omitempty"`
	// Observed is the pending would-be action ("add"/"update"/"revoke")
	// recorded while observe mode is on; empty once the action has really
	// been executed or no longer applies.
	Observed   string `json:"observed,omitempty"`
	ObservedAt string `json:"observedAt,omitempty"`
	// LastRevocation/LastRestore are written only on real state
	// transitions (never for observe-mode would-be actions) and survive
	// later transitions, so the most recent cut stays explainable.
	LastRevocation *RevocationInfo `json:"lastRevocation,omitempty"`
	LastRestore    *RestoreInfo    `json:"lastRestore,omitempty"`
}

func grantID(member, node string) string { return "grant-" + hash(member + ":" + node)[:24] }
func uuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (a *App) signalSync() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}
func (a *App) newGrant(m Member, n Node) error {
	g := Grant{ID: grantID(m.ID, n.ID), MemberID: m.ID, NodeID: n.ID, PanelID: n.PanelID, InboundID: n.InboundID, Protocol: n.Protocol, State: "pending"}
	g.Email = "subhub-" + hash(g.ID)[:24]
	secret := token()
	if n.Protocol == "VLESS" {
		secret = uuid()
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	b, _ := json.Marshal(g)
	if _, err = tx.Exec("INSERT INTO records VALUES('grant',?,?)", g.ID, b); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO secrets VALUES('grant_secret',?,?)", g.ID, a.encrypt("grant_secret:"+g.ID, secret)); err != nil {
		return err
	}
	return tx.Commit()
}
func remoteCredential(c remoteClient, protocol string) string {
	switch protocol {
	case "VLESS":
		return c.UUID
	case "Trojan":
		return c.Password
	default:
		return c.Auth
	}
}
// memberBlockReason classifies why checkMember would reject m, using the
// same precedence as checkMember itself; "" means the member passes and
// any revocation has a structural cause instead.
func memberBlockReason(m Member, at time.Time) string {
	if !m.Enabled {
		return "manual"
	}
	if exp, err := memberExpiry(m.Expires); err == nil && !exp.IsZero() && !at.Before(exp) {
		return "expired"
	}
	if m.Limit > 0 && memberQuotaUsed(m) >= m.Limit {
		return "quota"
	}
	return ""
}

// revocationReason decides the reason stamped on a grant that is about
// to be marked revoked. Member-level causes win. When the member itself
// is fine the revocation is structural: if the remote client is already
// gone, the access died with its lease; if a live client is being
// deleted, an admin-side change (unassign, node/inbound toggle, retire)
// is the cause and counts as manual.
func revocationReason(m Member, remote *remoteClient, at time.Time) string {
	if r := memberBlockReason(m, at); r != "" {
		return r
	}
	if remote == nil {
		return "lease"
	}
	return "manual"
}

// syncGrant reconciles one remote client with its grant. counts collects
// the round's would-be actions in observe mode (nil-safe via noteObserved
// callers passing a real map from syncAll).
func (a *App) syncGrant(ctx context.Context, p Panel, g *Grant, c *remoteClient, n Node, m Member, wanted bool, counts map[string]int) error {
	secret, err := a.readSecret("grant_secret", g.ID)
	if err != nil {
		return errors.New("授权凭据不可用")
	}
	wasRevoked := g.State == "revoked"
	if c != nil && remoteCredential(*c, g.Protocol) != secret {
		return errors.New("远端身份冲突，已停止自动修改")
	}
	observe := a.observeMode()
	if !wanted {
		if c != nil {
			if observe {
				a.noteObserved(g, "revoke", counts)
				return nil
			}
			if err = a.panelCall(ctx, p, "POST", "clients/del/"+url.PathEscape(g.Email), map[string]any{}, nil); err != nil {
				return err
			}
		}
		if g.State != "revoked" {
			// Real transition into revoked (observe-mode would-be
			// revocations returned above and never land here): stamp
			// the reason and the numbers it was decided on.
			g.LastRevocation = &RevocationInfo{Reason: revocationReason(m, c, time.Now()), At: now(), Used: memberQuotaUsed(m), Limit: m.Limit, Expires: m.Expires}
		}
		g.State, g.Lease = "revoked", 0
		g.LastUp, g.LastDown = 0, 0
		g.Observed, g.ObservedAt = "", ""
		return nil
	}
	// Short native expiry bounds the duration of stale permissions if SubHub
	// becomes unavailable. The worker renews every 60 seconds.
	lease := time.Now().Add(3 * time.Minute)
	exp, err := memberExpiry(m.Expires)
	if err != nil {
		return err
	}
	if !exp.IsZero() && exp.Before(lease) {
		lease = exp
	}
	total := int64(0)
	if m.Limit > 0 {
		remaining := int64(m.Limit*1e9) - int64(memberQuotaUsed(m)*1e9)
		if remaining <= 0 {
			if observe {
				// Quota ran out after the member-level check passed
				// (remote counters were sampled in between): the pending
				// disposition is a revocation, not an update.
				a.noteObserved(g, "revoke", counts)
				return nil
			}
			return errors.New("额度已耗尽，等待撤销")
		}
		// Cap each grant by remaining global balance plus its remote counter.
		total = remaining
		if c != nil && c.Traffic != nil {
			total += c.Traffic.Up + c.Traffic.Down
		}
	}
	payload := map[string]any{"email": g.Email, "enable": true, "expiryTime": lease.UnixMilli(), "totalGB": total, "limitIp": 0, "reset": 0, "subId": "sh-" + hash(g.ID)[:24], "comment": "Managed by SubHub", "flow": n.Flow}
	switch n.Protocol {
	case "VLESS":
		payload["id"] = secret
	case "Trojan":
		payload["password"] = secret
	case "Hysteria2":
		payload["auth"] = secret
	}
	if c == nil {
		if observe {
			a.noteObserved(g, "add", counts)
			return nil
		}
		err = a.panelCall(ctx, p, "POST", "clients/add", map[string]any{"client": payload, "inboundIds": []int{g.InboundID}}, nil)
	} else {
		if len(c.Inbounds) != 1 || c.Inbounds[0] != g.InboundID {
			return errors.New("远端授权关联被修改，请人工核对")
		}
		if observe {
			a.noteObserved(g, "update", counts)
			return nil
		}
		err = a.panelCall(ctx, p, "POST", "clients/update/"+url.PathEscape(g.Email), payload, nil)
	}
	if err != nil {
		return err
	}
	if wasRevoked {
		// Access came back: stamp it, but keep LastRevocation as
		// history so the cut stays explainable after the fact.
		g.LastRestore = &RestoreInfo{At: now()}
	}
	g.State, g.Lease = "active", lease.Unix()
	g.Observed, g.ObservedAt = "", ""
	return nil
}
func (a *App) syncAll(ctx context.Context) error {
	counts := map[string]int{"add": 0, "update": 0, "revoke": 0}
	nodes := map[string]Node{}
	members := map[string]Member{}
	for _, n := range loadNodes(a) {
		nodes[n.ID] = n
	}
	for _, raw := range a.list("member") {
		var m Member
		if json.Unmarshal(raw, &m) != nil {
			return errors.New("用户记录损坏")
		}
		if advanceCycle(&m, time.Now()) {
			if err := a.put("member", m.ID, m); err != nil {
				return err
			}
		}
		members[m.ID] = m
	}
	for _, m := range members {
		for _, nid := range m.NodeIDs {
			n, ok := nodes[nid]
			if !ok || n.PanelID == "" || !n.Enabled || checkMember(m, time.Now()) != nil {
				continue
			}
			var g Grant
			if a.get("grant", grantID(m.ID, n.ID), &g) != nil {
				if err := a.newGrant(m, n); err != nil {
					return err
				}
			} else if g.Retired && g.State == "revoked" && g.PanelID == n.PanelID && g.InboundID == n.InboundID && g.Protocol == n.Protocol {
				// A restored assignment may predate its grant. Reuse the identity
				// only after its rollback tombstone was successfully revoked.
				g.Retired, g.State = false, "pending"
				if err := a.put("grant", g.ID, g); err != nil {
					return err
				}
			}
		}
	}
	grants := []Grant{}
	for _, raw := range a.list("grant") {
		var g Grant
		if json.Unmarshal(raw, &g) != nil {
			return errors.New("授权记录损坏")
		}
		grants = append(grants, g)
	}
	panels := map[string]Panel{}
	remote := map[string]map[string]remoteClient{}
	inbounds := map[string]map[int]bool{}
	failures := 0
	for _, raw := range a.list("panel") {
		var p Panel
		json.Unmarshal(raw, &p)
		panels[p.ID] = p
		var clients []remoteClient
		var ibs []remoteInbound
		err := a.panelCall(ctx, p, "GET", "clients/list", nil, &clients)
		if err == nil {
			err = a.panelCall(ctx, p, "GET", "inbounds/list", nil, &ibs)
		}
		if err != nil {
			p.Status, p.Error = "error", err.Error()
			a.put("panel", p.ID, p)
			failures++
			continue
		}
		remote[p.ID] = map[string]remoteClient{}
		inbounds[p.ID] = map[int]bool{}
		for _, c := range clients {
			remote[p.ID][c.Email] = c
		}
		for _, ib := range ibs {
			inbounds[p.ID][ib.ID] = ib.Enable
		}
		p.Status, p.Error, p.LastSync = "connected", "", now()
		a.put("panel", p.ID, p)
	}
	// Persist sampled counters before calculating any user's remaining balance.
	for i := range grants {
		g := &grants[i]
		if remote[g.PanelID] == nil {
			continue
		}
		c, ok := remote[g.PanelID][g.Email]
		if !ok {
			continue
		}
		secret, err := a.readSecret("grant_secret", g.ID)
		if err != nil || remoteCredential(c, g.Protocol) != secret {
			continue
		}
		if c.Traffic != nil {
			up, down := c.Traffic.Up, c.Traffic.Down
			if up < 0 || down < 0 {
				continue
			}
			du, dd := up-g.LastUp, down-g.LastDown
			if du < 0 {
				du = up
			}
			if dd < 0 {
				dd = down
			}
			g.Used += du + dd
			g.LastUp, g.LastDown = up, down
			if err = a.put("grant", g.ID, g); err != nil {
				return err
			}
		}
	}
	totals := map[string]int64{}
	for _, g := range grants {
		totals[g.MemberID] += g.Used
	}
	for mid, total := range totals {
		m, ok := members[mid]
		if !ok {
			continue
		}
		if m.Used < float64(total)/1e9 {
			m.Used = float64(total) / 1e9
			members[mid] = m
			if err := a.put("member", mid, m); err != nil {
				return err
			}
		}
	}
	for i := range grants {
		g := &grants[i]
		p, ok := panels[g.PanelID]
		if !ok {
			g.State, g.Error = "error", "关联面板不存在"
			a.put("grant", g.ID, g)
			continue
		}
		if remote[g.PanelID] == nil {
			g.State, g.Error = "error", "面板连接失败，授权约 3 分钟后到期"
			a.put("grant", g.ID, g)
			continue
		}
		n, nok := nodes[g.NodeID]
		m, mok := members[g.MemberID]
		wanted := !g.Retired && nok && mok && n.Enabled && containsID(m.NodeIDs, n.ID) && checkMember(m, time.Now()) == nil && inbounds[p.ID][g.InboundID]
		var c *remoteClient
		if v, ok := remote[p.ID][g.Email]; ok {
			c = &v
		}
		previous := g.State
		if err := a.syncGrant(ctx, p, g, c, n, m, wanted, counts); err != nil {
			g.State, g.Error = "error", err.Error()
			failures++
		} else {
			g.LastSync, g.Error = now(), ""
		}
		if err := a.put("grant", g.ID, g); err != nil {
			return err
		}
		if previous != g.State {
			a.audit("grant."+g.State, g.MemberID)
		}
	}
	for mid, m := range members {
		managed, count, ready := 0, 0, true
		for _, nid := range m.NodeIDs {
			n, ok := nodes[nid]
			if !ok {
				continue
			}
			count++
			if n.PanelID != "" {
				managed++
				var g Grant
				if a.get("grant", grantID(mid, nid), &g) != nil || g.State != "active" {
					ready = false
				}
			}
		}
		if managed == 0 {
			m.Provision = "manual"
		} else if !m.Enabled || checkMember(m, time.Now()) != nil {
			m.Provision = "revoked"
		} else if managed == count && ready {
			m.Provision = "ready"
		} else {
			m.Provision = "pending"
		}
		if err := a.put("member", mid, m); err != nil {
			return err
		}
	}
	a.noteSyncRound(counts)
	if failures > 0 {
		return fmt.Errorf("%d 项同步失败，请检查面板连接和授权状态", failures)
	}
	return nil
}
func (a *App) startWorker(ctx context.Context) {
	a.signalSync()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-a.wake:
			}
			a.writeMu.Lock()
			a.recordBackupTask(a.automaticBackup(false))
			a.runFetchRetentionIfDue()
			a.accumulateTraffic()
			work, cancel := context.WithTimeout(ctx, 50*time.Second)
			err := a.syncAll(work)
			cancel()
			if len(a.list("panel")) > 0 {
				t := Task{ID: "sync-latest", Name: "节点授权与用量同步", Kind: "sync", Created: now(), Status: "success", Detail: "同步完成，每 60 秒自动更新"}
				if err != nil {
					t.Status, t.Detail = "failed", err.Error()
				} else if a.observeMode() {
					c, _ := a.lastSyncRound()
					t.Detail = fmt.Sprintf("观察模式：本轮将新增 %d、更新 %d、撤销 %d（均未执行），每 60 秒自动更新", c["add"], c["update"], c["revoke"])
				}
				a.put("task", t.ID, t)
			}
			a.writeMu.Unlock()
		}
	}()
}
func (a *App) managedCredential(m Member, n Node) (string, error) {
	var g Grant
	if a.get("grant", grantID(m.ID, n.ID), &g) != nil || g.State != "active" || g.Lease <= time.Now().Unix() {
		return "", errors.New("节点独立授权尚未同步成功，请稍后刷新")
	}
	return a.readSecret("grant_secret", g.ID)
}
func (a *App) hasLiveGrants(kind, recordID string) bool {
	for _, raw := range a.list("grant") {
		var g Grant
		json.Unmarshal(raw, &g)
		if ((kind == "node" && g.NodeID == recordID) || (kind == "member" && g.MemberID == recordID) || (kind == "server" && func() bool { var p Panel; return a.get("panel", g.PanelID, &p) == nil && p.ServerID == recordID }())) && g.State != "revoked" {
			return true
		}
	}
	return false
}
