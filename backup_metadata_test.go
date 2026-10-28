package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupMetadataVerifiesContentWithoutExposingSecrets(t *testing.T) {
	a := testApp(t)
	fixture(t, a)
	if err := a.automaticBackup(false); err != nil {
		t.Fatal(err)
	}
	secret, err := a.readSecret("node_secret", "node-a")
	if err != nil {
		t.Fatal(err)
	}
	w := request(a, "GET", "/api/admin/security", nil, true)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "node-a") || strings.Contains(w.Body.String(), "2001:db8") {
		t.Fatal("backup metadata exposed private content")
	}
	var result struct {
		Backups []localBackupInfo `json:"backups"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Backups) != 1 {
		t.Fatalf("metadata count: %d", len(result.Backups))
	}
	b := result.Backups[0]
	if b.Status != "verified" || b.CreatedAt == "" || b.Size < 100 || b.Counts["node"] != 1 || b.Counts["member"] != 1 {
		t.Fatalf("unexpected metadata: %+v", b)
	}
	if request(a, "GET", "/api/admin/security", nil, false).Code != http.StatusUnauthorized {
		t.Fatal("backup listing must require authentication")
	}
}

func TestBackupMetadataDistinguishesEmptyCorruptAndOversizedSnapshots(t *testing.T) {
	a := testApp(t)
	if err := a.automaticBackup(false); err != nil {
		t.Fatal(err)
	}
	name := a.backupFiles()[0]
	if got := a.inspectLocalBackup(name); got.Status != "empty" {
		t.Fatalf("empty snapshot: %+v", got)
	}
	path := filepath.Join(a.dir, "backups", name)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	b[len(b)-1] ^= 1
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	if got := a.inspectLocalBackup(name); got.Status != "invalid" {
		t.Fatalf("corrupt snapshot: %+v", got)
	}
	if a.automaticBackup(false) == nil {
		t.Fatal("existing corrupt backup was accepted as success")
	}
	if err := os.Truncate(path, (16<<20)+1); err != nil {
		t.Fatal(err)
	}
	if got := a.inspectLocalBackup(name); got.Status != "unchecked" {
		t.Fatalf("oversized snapshot: %+v", got)
	}
}

func TestBackupFailureRetainsStageAndOSCauseWithoutSensitivePath(t *testing.T) {
	var err error = &backupOperationError{"写入加密文件", &os.PathError{Op: "open", Path: "/private/do-not-expose", Err: os.ErrPermission}}
	detail := backupFailureDetail(err)
	if !strings.Contains(detail, "写入加密文件") || !strings.Contains(detail, "permission denied") || strings.Contains(detail, "do-not-expose") {
		t.Fatal(detail)
	}
	if strings.Contains(backupFailureDetail(errors.New("sensitive-secret-marker")), "sensitive-secret-marker") {
		t.Fatal("unknown errors must not expose payloads")
	}
	a := testApp(t)
	if err := os.WriteFile(filepath.Join(a.dir, "backups"), []byte("block directory"), 0600); err != nil {
		t.Fatal(err)
	}
	err = a.automaticBackup(false)
	if err == nil {
		t.Fatal("blocked backup directory was accepted")
	}
	a.recordBackupTask(err)
	var task Task
	if a.get("task", "backup-latest", &task) != nil || task.Status != "failed" || strings.Contains(task.Detail, a.dir) {
		t.Fatalf("unexpected task: %+v", task)
	}
}

func TestBackupTaskAdvancesOnNewDayAndClearsFailure(t *testing.T) {
	a := testApp(t)
	yesterday := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	if err := a.put("task", "backup-latest", Task{ID: "backup-latest", Status: "success", Created: yesterday}); err != nil {
		t.Fatal(err)
	}
	a.recordBackupTask(nil)
	var task Task
	if a.get("task", "backup-latest", &task) != nil || task.Created == yesterday {
		t.Fatal("daily success timestamp did not advance")
	}
	a.recordBackupTask(errors.New("failed"))
	a.recordBackupTask(nil)
	if a.get("task", "backup-latest", &task) != nil || task.Status != "success" {
		t.Fatal("later success did not clear failure")
	}
}
