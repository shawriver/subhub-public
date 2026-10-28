package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type App struct {
	komari          komariCache
	dir             string
	wake            chan struct{}
	probeWake       chan struct{}
	nodeLatencyWork chan struct{}
	protocolWork    chan struct{}
	protocolMu      sync.Mutex
	protocolCancel  context.CancelFunc
	protocolNode    string
	protocolRun     string
	probeSocket     string
	instanceName    string
	db              *sql.DB
	seal            cipher.AEAD
	origin          string
	mu              sync.Mutex
	writeMu         sync.Mutex
	obsMu           sync.Mutex
	obsLast         map[string]int
	obsLastAt       string
	authWork        chan struct{}
	attempts        map[string][]time.Time
}
type Server struct {
	KomariUUID     string  `json:"komariUuid,omitempty"`
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Region         string  `json:"region"`
	Flag           string  `json:"flag"`
	Provider       string  `json:"provider"`
	Address        string  `json:"address"`
	Status         string  `json:"status"`
	CPU            float64 `json:"cpu"`
	Memory         float64 `json:"memory"`
	Disk           float64 `json:"disk"`
	Upload         float64 `json:"upload"`
	Download       float64 `json:"download"`
	Used           float64 `json:"used"`
	Limit          float64 `json:"limit"`
	Specs          string  `json:"specs"`
	Expires        string  `json:"expires"`
	Price          string  `json:"price"`
	Role           string  `json:"role"`
	Note           string  `json:"note"`
	LastSeen       string  `json:"lastSeen"`
	Agent          bool    `json:"agent"`
	ConnectAllowed bool    `json:"connectAllowed"`
}
type Node struct {
	PanelID     string   `json:"panelId,omitempty"`
	InboundID   int      `json:"inboundId,omitempty"`
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	ServerID    string   `json:"serverId"`
	Protocol    string   `json:"protocol"`
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	Enabled     bool     `json:"enabled"`
	Tags        []string `json:"tags"`
	Latency     *int     `json:"latency"`
	SNI         string   `json:"sni"`
	Transport   string   `json:"transport"`
	Path        string   `json:"path"`
	WSHost      string   `json:"wsHost"`
	PublicKey   string   `json:"publicKey"`
	ShortID     string   `json:"shortId"`
	Flow        string   `json:"flow"`
	Security    string   `json:"security"`
	Fingerprint string   `json:"fingerprint"`
	ALPN        string   `json:"alpn"`
	// ExternalPort overrides the inbound's local port for exports. It is
	// needed when Caddy or another reverse proxy fronts a loopback inbound.
	ExternalPort int `json:"externalPort,omitempty"`
	// ExternalSNI is the public TLS name for such a reverse-proxied node.
	ExternalSNI string `json:"externalSni,omitempty"`
	Credential  string `json:"credential,omitempty"`
	Applied     bool   `json:"applied"`
	Managed     bool   `json:"managed"`
}
type Member struct {
	ResetDay                int      `json:"resetDay"`
	CycleStart              string   `json:"cycleStart,omitempty"`
	CycleEnd                string   `json:"cycleEnd,omitempty"`
	CycleBase               float64  `json:"cycleBase"`
	QuotaUsed               float64  `json:"quotaUsed"`
	ConnectionLimitOverride *int     `json:"connectionLimitOverride"`
	ConnectionLimit         int      `json:"connectionLimit"`
	ConnectionLimitSource   string   `json:"connectionLimitSource"`
	DeviceLimit             int      `json:"deviceLimit"`
	DevicesUsed             int      `json:"devicesUsed"`
	DeviceOverLimit         bool     `json:"deviceOverLimit"`
	HasAnomaly              bool     `json:"hasAnomaly"`
	AnomalyRules            []string `json:"anomalyRules,omitempty"`
	AnomalySummary          string   `json:"anomalySummary,omitempty"`
	SubscriptionIDs         []string `json:"subscriptionIds"`
	AssignmentMode          string   `json:"assignmentMode,omitempty"`
	AllocationNodeIDs       []string `json:"allocationNodeIds"`
	ID                      string   `json:"id"`
	Name                    string   `json:"name"`
	Email                   string   `json:"email"`
	Enabled                 bool     `json:"enabled"`
	Expires                 string   `json:"expires"`
	Limit                   float64  `json:"limit"`
	Used                    float64  `json:"used"`
	NodeIDs                 []string `json:"nodeIds"`
	GroupID                 string   `json:"groupId"`
	Note                    string   `json:"note"`
	Provision               string   `json:"provision"`
}
type Profile struct {
	CustomNodes       bool     `json:"customNodes,omitempty"`
	TemplateID        string   `json:"templateId,omitempty"`
	FollowMemberNodes bool     `json:"followMemberNodes"`
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	MemberID          string   `json:"memberId"`
	NodeIDs           []string `json:"nodeIds"`
	Format            string   `json:"format"`
	Rules             []string `json:"rules"`
	Updated           string   `json:"updated"`
}
type Task struct {
	Expires  int64  `json:"expires,omitempty"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	ServerID string `json:"serverId"`
	Status   string `json:"status"`
	Detail   string `json:"detail"`
	Created  string `json:"created"`
	Kind     string `json:"kind"`
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func id() string           { return token()[:18] }
func hash(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func newApp(dir, origin string) (*App, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dir, "master.key")
	key, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) {
		if _, dbErr := os.Stat(filepath.Join(dir, "subhub.db")); !os.IsNotExist(dbErr) {
			return nil, errors.New("master key missing from existing data directory; restore the original key")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		if err = os.WriteFile(keyPath, key, 0600); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("invalid master key")
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	db, err := sql.Open("sqlite", filepath.Join(dir, "subhub.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	schema := `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS admin (username TEXT PRIMARY KEY, password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS secrets (kind TEXT NOT NULL, id TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS access_tokens (digest TEXT PRIMARY KEY, profile TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, action TEXT, target TEXT);
 CREATE TABLE IF NOT EXISTS setup (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_counter (id TEXT PRIMARY KEY, step INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS subscription_fetches (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, profile TEXT NOT NULL, member TEXT NOT NULL, ip TEXT NOT NULL, ua TEXT NOT NULL, format TEXT NOT NULL, status INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS subscription_fetch_member ON subscription_fetches(member,id);
 `
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(filepath.Join(dir, "subhub.db"), 0600)
	a := &App{dir: dir, wake: make(chan struct{}, 1), probeWake: make(chan struct{}, 1), nodeLatencyWork: make(chan struct{}, 1), db: db, seal: gcm, origin: origin, attempts: map[string][]time.Time{}, authWork: make(chan struct{}, 2)}
	a.protocolWork = make(chan struct{}, 1)
	a.probeSocket = "/run/subhub-probe/api.sock"
	if err := a.migrateSubscriptions(); err != nil {
		db.Close()
		return nil, err
	}
	return a, nil
}
func (a *App) list(kind string) []json.RawMessage {
	out := []json.RawMessage{}
	rows, err := a.db.Query("SELECT body FROM records WHERE kind=? ORDER BY rowid", kind)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b string
		if rows.Scan(&b) == nil {
			out = append(out, json.RawMessage(b))
		}
	}
	return out
}
func (a *App) get(kind, id string, v any) error {
	var b string
	err := a.db.QueryRow("SELECT body FROM records WHERE kind=? AND id=?", kind, id).Scan(&b)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(b), v)
}
func (a *App) put(kind, id string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = a.db.Exec("INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", kind, id, b)
	return err
}
func (a *App) encrypt(context, value string) []byte {
	nonce := make([]byte, a.seal.NonceSize())
	_, _ = rand.Read(nonce)
	return a.seal.Seal(nonce, nonce, []byte(value), []byte(context))
}
func (a *App) secret(kind, id, value string) error {
	_, err := a.db.Exec("INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", kind, id, a.encrypt(kind+":"+id, value))
	return err
}
func (a *App) readSecret(kind, id string) (string, error) {
	var b []byte
	if err := a.db.QueryRow("SELECT value FROM secrets WHERE kind=? AND id=?", kind, id).Scan(&b); err != nil {
		return "", err
	}
	n := a.seal.NonceSize()
	if len(b) < n {
		return "", errors.New("invalid encrypted record")
	}
	p, err := a.seal.Open(nil, b[:n], b[n:], []byte(kind+":"+id))
	return string(p), err
}
func (a *App) audit(action, target string) {
	_, _ = a.db.Exec("INSERT INTO audit(at,action,target) VALUES(?,?,?)", now(), action, target)
}
func (a *App) issueSetup() (string, error) {
	tx, err := a.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM admin").Scan(&count); err != nil {
		return "", err
	}
	if count != 0 {
		return "", errors.New("administrator already initialized")
	}
	if _, err = tx.Exec("DELETE FROM setup"); err != nil {
		return "", err
	}
	t := token()
	if _, err = tx.Exec("INSERT INTO setup VALUES(?,?)", hash(t), time.Now().Add(72*time.Hour).Unix()); err != nil {
		return "", err
	}
	return t, tx.Commit()
}
