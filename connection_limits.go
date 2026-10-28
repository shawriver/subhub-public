package main

import "errors"

const maxConnectionLimit = 10000

func validConnectionLimit(limit int) bool {
	return limit >= 0 && limit <= maxConnectionLimit
}

// subscriptionConnectionLimit resolves the default attached to a member's
// assigned subscriptions. A member may combine several subscriptions; the
// broadest positive default wins, and an unlimited subscription keeps the
// combined default unlimited. A user-specific override always wins over this
// value.
func subscriptionConnectionLimit(ids []string, lookup func(string) (Subscription, error)) (int, error) {
	limit := 0
	for _, id := range uniqueIDs(ids) {
		s, err := lookup(id)
		if err != nil {
			return 0, errors.New("分配的订阅不存在")
		}
		if s.ConnectionLimit == 0 {
			return 0, nil
		}
		if s.ConnectionLimit > limit {
			limit = s.ConnectionLimit
		}
	}
	return limit, nil
}

// effectiveConnectionLimit returns the limit shown and carried by one member.
// Source is kept separate so the UI never implies that a subscription default
// is a user-specific override.
func (a *App) effectiveConnectionLimit(m Member) (int, string) {
	if m.ConnectionLimitOverride != nil {
		return *m.ConnectionLimitOverride, "override"
	}
	if len(m.SubscriptionIDs) == 0 {
		return 0, "unlimited"
	}
	limit, err := subscriptionConnectionLimit(m.SubscriptionIDs, func(id string) (Subscription, error) {
		var s Subscription
		err := a.get("subscription", id, &s)
		return s, err
	})
	if err != nil {
		return 0, "unavailable"
	}
	return limit, "subscription"
}
