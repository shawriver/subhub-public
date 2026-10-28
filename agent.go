package main

import "net/http"

// Reserved historical kinds remain blocked in generic CRUD so old tasks cannot
// be reintroduced as executable operations.
func validAgentAction(kind string) bool {
	return kind == "check-updates" || kind == "system-update" || kind == "host-reboot" || kind == "proxy-restart"
}
func (a *App) agentPoll(w http.ResponseWriter, r *http.Request) {
	apiError(w, http.StatusGone, "SubHub 主机 Agent 已停用，主机监控请使用 Komari")
}
func (a *App) queueAgentAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path != "host-actions" {
		return false
	}
	apiError(w, http.StatusGone, "SubHub 不再执行系统更新或主机重启")
	return true
}
