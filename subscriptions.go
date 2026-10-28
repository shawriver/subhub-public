package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// Subscription is a reusable node collection. Personal profiles and access
// tokens remain per-member so sharing a collection never shares a download key.
type Subscription struct {
	ConnectionLimit int      `json:"connectionLimit"`
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Note            string   `json:"note"`
	NodeIDs         []string `json:"nodeIds"`
	Updated         string   `json:"updated"`
}

// Assign one reusable package to several members in one transaction.
// This adds/removes only this package; other packages and custom profiles stay.
func (a *App) packageMembersAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) != 3 || parts[0] != "subscriptions" || parts[2] != "members" {
		return false
	}
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return true
	}
	var in struct {
		MemberIDs []string `json:"memberIds"`
	}
	if decodeBody(r, &in) != nil || in.MemberIDs == nil {
		apiError(w, 400, "请选择订阅用户")
		return true
	}
	tx, err := a.db.Begin()
	if err != nil {
		apiError(w, 500, "数据库不可用")
		return true
	}
	defer tx.Rollback()
	subscriptions, err := txSubscriptions(tx)
	if err != nil {
		apiError(w, 500, "订阅暂不可读")
		return true
	}
	if _, ok := subscriptions[parts[1]]; !ok {
		apiError(w, 404, "订阅不存在")
		return true
	}
	members, err := txMembers(tx)
	if err != nil {
		apiError(w, 500, "用户暂不可读")
		return true
	}
	for _, id := range in.MemberIDs {
		found := false
		for _, m := range members {
			if m.ID == id {
				found = true
				break
			}
		}
		if !found {
			apiError(w, 400, "所选用户不存在")
			return true
		}
	}
	changed := 0
	for _, m := range members {
		selected := containsID(in.MemberIDs, m.ID)
		assigned := containsID(m.SubscriptionIDs, parts[1])
		if selected == assigned {
			continue
		}
		if selected {
			m.SubscriptionIDs = append(m.SubscriptionIDs, parts[1])
		} else {
			ids := []string{}
			for _, id := range m.SubscriptionIDs {
				if id != parts[1] {
					ids = append(ids, id)
				}
			}
			m.SubscriptionIDs = ids
		}
		m.AssignmentMode = "subscriptions"
		m.AllocationNodeIDs, err = subscriptionNodes(m.SubscriptionIDs, func(id string) (Subscription, error) {
			s, ok := subscriptions[id]
			if !ok {
				return s, sql.ErrNoRows
			}
			return s, nil
		})
		if err == nil {
			err = reconcileMemberAccess(tx, m)
		}
		if err != nil {
			apiError(w, 500, "订阅分配失败，修改已回滚")
			return true
		}
		changed++
	}
	if tx.Commit() != nil {
		apiError(w, 500, "订阅分配失败")
		return true
	}
	a.signalSync()
	a.audit("package.assign", parts[1])
	writeJSON(w, 200, map[string]int{"changed": changed})
	return true
}

func subscriptionNodes(ids []string, lookup func(string) (Subscription, error)) ([]string, error) {
	nodes := []string{}
	for _, id := range uniqueIDs(ids) {
		s, err := lookup(id)
		if err != nil {
			return nil, errors.New("分配的订阅不存在")
		}
		nodes = append(nodes, s.NodeIDs...)
	}
	return uniqueIDs(nodes), nil
}

func txSubscriptions(tx *sql.Tx) (map[string]Subscription, error) {
	rows, err := tx.Query("SELECT body FROM records WHERE kind='subscription'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Subscription{}
	for rows.Next() {
		var b []byte
		var s Subscription
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, &s); err != nil {
			return nil, err
		}
		out[s.ID] = s
	}
	return out, rows.Err()
}

func txMembers(tx *sql.Tx) ([]Member, error) {
	rows, err := tx.Query("SELECT body FROM records WHERE kind='member'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		var b []byte
		var m Member
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Reconcile all assigned members, and their private export profiles, in the
// same transaction as a collection edit. Overlapping collections form a union.
func reconcileSubscribers(tx *sql.Tx, subscriptionID string) error {
	subscriptions, err := txSubscriptions(tx)
	if err != nil {
		return err
	}
	members, err := txMembers(tx)
	if err != nil {
		return err
	}
	for _, m := range members {
		if !containsID(m.SubscriptionIDs, subscriptionID) {
			continue
		}
		m.NodeIDs, err = subscriptionNodes(m.SubscriptionIDs, func(id string) (Subscription, error) {
			s, ok := subscriptions[id]
			if !ok {
				return s, sql.ErrNoRows
			}
			return s, nil
		})
		if err != nil {
			return err
		}
		m.AllocationNodeIDs = append([]string{}, m.NodeIDs...)
		if err := reconcileMemberAccess(tx, m); err != nil {
			return err
		}
	}
	return nil
}

// Package/direct allocation is separate from custom subscriptions. Grants use
// their union, while each profile exports only its own node selection.
func allocationNodes(m Member) []string {
	if m.AllocationNodeIDs != nil {
		return m.AllocationNodeIDs
	}
	return m.NodeIDs
}

func reconcileMemberAccess(tx *sql.Tx, m Member) error {
	base := append([]string{}, allocationNodes(m)...)
	rows, err := tx.Query("SELECT body FROM records WHERE kind='profile' AND json_extract(body,'$.memberId')=?", m.ID)
	if err != nil {
		return err
	}
	all := append([]string{}, base...)
	for rows.Next() {
		var b []byte
		var p Profile
		if err := rows.Scan(&b); err != nil {
			rows.Close()
			return err
		}
		if err := json.Unmarshal(b, &p); err != nil {
			rows.Close()
			return err
		}
		if p.CustomNodes {
			all = append(all, p.NodeIDs...)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	m.AllocationNodeIDs, m.NodeIDs = base, uniqueIDs(all)
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE records SET body=? WHERE kind='member' AND id=?", b, m.ID); err != nil {
		return err
	}
	return reconcileProfiles(tx, m)
}

// Legacy assignments become one collection per member without broadening any
// profile, changing tokens, or replacing grant identities. Restart is idempotent.
func migrateSubscriptionsTx(tx *sql.Tx) error {
	members, err := txMembers(tx)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.SubscriptionIDs != nil || m.AssignmentMode == "nodes" {
			continue
		}
		m.SubscriptionIDs = []string{}
		if len(m.NodeIDs) > 0 {
			s := Subscription{ID: "legacy-sub-" + hash(m.ID)[:24], Name: m.Name + "的订阅", NodeIDs: append([]string{}, m.NodeIDs...), Updated: now()}
			var profileBody []byte
			err := tx.QueryRow("SELECT body FROM records WHERE kind='profile' AND json_extract(body,'$.memberId')=? ORDER BY rowid LIMIT 1", m.ID).Scan(&profileBody)
			if err == nil {
				var p Profile
				if err := json.Unmarshal(profileBody, &p); err != nil {
					return err
				}
				s.Name = p.Name
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			b, err := json.Marshal(s)
			if err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO records VALUES('subscription',?,?)", s.ID, b); err != nil {
				return err
			}
			m.SubscriptionIDs = []string{s.ID}
		}
		b, err := json.Marshal(m)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE records SET body=? WHERE kind='member' AND id=?", b, m.ID); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) migrateSubscriptions() error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := migrateSubscriptionsTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}
