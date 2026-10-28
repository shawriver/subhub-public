package main

import (
	"encoding/json"
	"errors"
	"math"
	"time"
)

var billingZone = time.FixedZone("Asia/Shanghai", 8*3600)

func billingBoundary(year int, month time.Month, day int) time.Time {
	last := time.Date(year, month+1, 0, 0, 0, 0, 0, billingZone).Day()
	if day > last {
		day = last
	}
	return time.Date(year, month, day, 0, 0, 0, 0, billingZone)
}

func billingWindow(at time.Time, day int) (time.Time, time.Time) {
	local := at.In(billingZone)
	start := billingBoundary(local.Year(), local.Month(), day)
	if local.Before(start) {
		start = billingBoundary(local.Year(), local.Month()-1, day)
	}
	next := billingBoundary(start.Year(), start.Month()+1, day)
	return start, next
}

func advanceCycle(m *Member, at time.Time) bool {
	if m.ResetDay < 1 || m.ResetDay > 31 {
		return false
	}
	start, end := billingWindow(at, m.ResetDay)
	if m.CycleStart == start.UTC().Format(time.RFC3339) && m.CycleEnd == end.UTC().Format(time.RFC3339) {
		return false
	}
	m.CycleStart, m.CycleEnd = start.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339)
	m.CycleBase = m.Used
	return true
}

func memberQuotaUsed(m Member) float64 {
	if m.ResetDay > 0 && m.CycleStart != "" {
		return math.Max(0, m.Used-m.CycleBase)
	}
	return m.Used
}

func validCycle(m Member) bool {
	if m.ResetDay < 0 || m.ResetDay > 31 || !validQuota(m.CycleBase, 0) || m.CycleBase > m.Used {
		return false
	}
	if m.ResetDay == 0 {
		return m.CycleBase == 0 && m.CycleStart == "" && m.CycleEnd == ""
	}
	start, err := time.Parse(time.RFC3339, m.CycleStart)
	if err != nil {
		return false
	}
	a, b := billingWindow(start, m.ResetDay)
	return start.Equal(a) && m.CycleEnd == b.UTC().Format(time.RFC3339)
}

func configureCycle(m *Member, old Member, at time.Time) error {
	if m.ResetDay < 0 || m.ResetDay > 31 {
		return errors.New("流量重置日必须是 1–31，0 表示累计额度")
	}
	m.CycleStart, m.CycleEnd, m.CycleBase = old.CycleStart, old.CycleEnd, old.CycleBase
	if m.ResetDay == 0 {
		m.CycleStart, m.CycleEnd, m.CycleBase = "", "", 0
	} else if m.ResetDay != old.ResetDay {
		m.CycleStart = ""
		advanceCycle(m, at)
	}
	m.QuotaUsed = 0 // Derived only when returning a view; never accept client values.
	m.HasAnomaly, m.AnomalyRules, m.AnomalySummary = false, nil, ""
	return nil
}

func (a *App) memberViews() []Member {
	out := []Member{}
	for _, raw := range a.list("member") {
		var m Member
		if json.Unmarshal(raw, &m) == nil {
			m.QuotaUsed = memberQuotaUsed(m)
			m.ConnectionLimit, m.ConnectionLimitSource = a.effectiveConnectionLimit(m)
			// Device estimate is derived on read like QuotaUsed; a stats
			// failure degrades to 0 rather than failing the whole view.
			from, to := deviceWindow(m, time.Now())
			if n, err := a.countDistinctDevices(m.ID, from, to); err == nil {
				m.DevicesUsed = n
			}
			m.DeviceOverLimit = false
			// Fetch-anomaly flags are likewise derived on read (spec item
			// 4.2): mark-only, they never block or disable anything.
			if has, rules, summary := a.memberAnomalySummary(m.ID, time.Now().AddDate(0, 0, -30)); has {
				m.HasAnomaly, m.AnomalyRules, m.AnomalySummary = true, rules, summary
			}
			out = append(out, m)
		}
	}
	return out
}
