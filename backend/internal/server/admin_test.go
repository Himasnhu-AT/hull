package server

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/store"
)

func adminEnv(t *testing.T) *env {
	e := newEnv(t, func(c *config.Config) { c.AdminEmails = []string{"boss@example.com"} })
	e.s.now = func() time.Time { return time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC) }
	return e
}

func (e *env) get(c *http.Client, path string) (*http.Response, string) {
	e.t.Helper()
	resp, err := c.Get(e.ts.URL + path)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

// adminBrowser is a browser signed in as an account Google has vouched for, which is what an admin must be.
func (e *env) adminBrowser(email string) *http.Client {
	e.t.Helper()
	u, err := e.st.CreateGoogleUser(strings.ToLower(email), "sub-"+strings.ToLower(email), e.s.now())
	if err != nil {
		e.t.Fatal(err)
	}
	id := randomString(32)
	if err := e.st.CreateSession(hashSecret(id), u.ID, e.s.now().Add(sessionTTL)); err != nil {
		e.t.Fatal(err)
	}
	c := e.browser()
	at, _ := url.Parse(e.ts.URL)
	c.Jar.SetCookies(at, []*http.Cookie{{Name: sessionCookie, Value: id, Path: "/"}})
	return c
}

// seedAdmin fills the database with numbers that are easy to check by hand.
func (e *env) seedAdmin() {
	e.t.Helper()
	day := func(daysAgo int, hour int) time.Time { return time.Date(2026, 11, 24-daysAgo, hour, 0, 0, 0, time.UTC) }
	for _, w := range []struct {
		email, src string
		at         time.Time
	}{{"a@example.com", "home", day(0, 1)}, {"b@example.com", "home", day(0, 2)}, {"c@example.com", "", day(0, 14)}, {"d@example.com", "home", day(1, 23)},
		{"e@example.com", "x", day(6, 0)}, {"f@example.com", "x", day(10, 12)}, {"=cmd@example.com", "x", day(20, 12)}} {
		if _, err := e.st.AddWaitlist(w.email, w.src, w.at); err != nil {
			e.t.Fatal(err)
		}
	}
	u, err := e.st.UserByEmail("boss@example.com")
	if err != nil {
		e.t.Fatal(err)
	}
	for _, us := range []struct {
		in, out int64
		at      time.Time
	}{{100, 50, day(0, 3)}, {100, 50, day(0, 4)}, {200, 20, day(3, 4)}, {999, 999, day(8, 4)}} {
		if err := e.st.AddUsage(u.ID, 0, "claude-opus-5-5", us.in, us.out, us.at); err != nil {
			e.t.Fatal(err)
		}
	}
	for _, v := range []store.CommunityVersion{{GameID: "g1", Version: "1.0.0"}, {GameID: "g1", Version: "1.1.0"}, {GameID: "g2", Version: "1.0.0"}} {
		v.Title, v.PublishedAt = "T", day(0, 1)
		if err := e.st.AddCommunityVersion(v); err != nil {
			e.t.Fatal(err)
		}
	}
}

func TestAdminHiddenFromEveryoneElse(t *testing.T) {
	e := adminEnv(t)
	paths := []string{"/admin", "/admin/waitlist.csv", "/api/admin/stats"}
	out := e.browser()
	for _, p := range paths {
		resp, body := e.get(out, p)
		_, wantBody := e.get(e.browser(), "/no-such-route")
		if resp.StatusCode != 404 || body != wantBody {
			t.Errorf("signed out %s: %d %q (an unknown route answers %q)", p, resp.StatusCode, body, wantBody)
		}
	}
	user := e.browser()
	e.signup(user, "someone@example.com", "correct horse battery")
	for _, p := range paths {
		if resp, body := e.get(user, p); resp.StatusCode != 404 || strings.Contains(body, "Waitlist") {
			t.Errorf("non-admin %s: %d", p, resp.StatusCode)
		}
	}
	// A bearer token is not a session: only the cookie opens the admin.
	if resp, _ := e.do("GET", "/api/admin/stats", e.token("tok@example.com"), nil, ""); resp.StatusCode != 404 {
		t.Errorf("token: %d", resp.StatusCode)
	}
}

func TestAdminNobodyWhenSettingEmpty(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()
	e.signup(c, "boss@example.com", "correct horse battery")
	if resp, _ := e.get(c, "/admin"); resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

// Sign-up takes any address without proof, so a password account at an admin's address must not open the admin:
// before this, whoever registered the address first was the admin.
func TestAdminNeedsGoogle(t *testing.T) {
	e := adminEnv(t)
	c := e.browser()
	e.signup(c, "boss@example.com", "correct horse battery")
	for _, p := range []string{"/admin", "/admin/waitlist.csv", "/api/admin/stats"} {
		if resp, body := e.get(c, p); resp.StatusCode != 404 || strings.Contains(body, "Waitlist") {
			t.Errorf("a password account at the admin's address got %s: %d", p, resp.StatusCode)
		}
	}
}

func TestAdminPage(t *testing.T) {
	e := adminEnv(t)
	c := e.adminBrowser("Boss@Example.com")
	e.seedAdmin()
	resp, body := e.get(c, "/admin")
	if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "no-store" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("status %d headers %v", resp.StatusCode, resp.Header)
	}
	kind := e.st.Kind()
	for _, want := range []string{"<b>7</b><span class=\"muted\">total", "<b>3</b><span class=\"muted\">today", "<b>5</b><span class=\"muted\">last 7 days",
		"2026-11-24", "2026-11-11", "f@example.com", "/admin/waitlist.csv", "boss@example.com", kind, "go1.", "UTC", "Last 14 days"} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(strings.ToLower(body), "<script") {
		t.Error("admin page has a script")
	}
}

func TestAdminStatsJSON(t *testing.T) {
	e := adminEnv(t)
	c := e.adminBrowser("boss@example.com")
	e.signup(e.browser(), "g@example.com", "correct horse battery")
	e.seedAdmin()
	resp, body := e.get(c, "/api/admin/stats")
	if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	var got struct {
		store.AdminStats
		System adminSystem `json:"system"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err, body)
	}
	if got.WaitlistTotal != 7 || got.WaitlistToday != 3 || got.WaitlistWeek != 5 || got.AccountsTotal != 2 || got.TokensActive != 0 ||
		got.UsageToday != (store.UsageTotals{Requests: 2, Input: 200, Output: 100}) || got.UsageWeek != (store.UsageTotals{Requests: 3, Input: 400, Output: 120}) ||
		got.CommunityGames != 2 || got.CommunityVersions != 3 || got.SchemaVersion != store.SchemaVersion || got.DBKind != e.st.Kind() ||
		got.System.GoVersion == "" || got.System.StartedAt == "" {
		t.Fatalf("stats: %s", body)
	}
	if len(got.WaitlistDays) != 14 || got.WaitlistDays[0] != (store.DayCount{Day: "2026-11-24", Count: 3}) || got.WaitlistDays[1] != (store.DayCount{Day: "2026-11-23", Count: 1}) ||
		got.WaitlistDays[2].Count != 0 || got.WaitlistDays[6] != (store.DayCount{Day: "2026-11-18", Count: 1}) || got.WaitlistDays[10] != (store.DayCount{Day: "2026-11-14", Count: 1}) || got.WaitlistDays[13].Day != "2026-11-11" {
		t.Fatalf("days: %+v", got.WaitlistDays)
	}
	if len(got.WaitlistNewest) != 7 || got.WaitlistNewest[0].Email != "=cmd@example.com" {
		t.Fatalf("newest: %+v", got.WaitlistNewest)
	}
	if len(got.TopToday) != 1 || got.TopToday[0].Email != "boss@example.com" || got.TopToday[0].Requests != 2 || got.TopToday[0].Input != 200 {
		t.Fatalf("top: %+v", got.TopToday)
	}
	if len(got.AccountsNewest) != 2 || !got.AccountsNewest[0].Password || got.AccountsNewest[0].Google {
		t.Fatalf("accounts: %+v", got.AccountsNewest)
	}
}

func TestAdminWaitlistCSV(t *testing.T) {
	e := adminEnv(t)
	c := e.adminBrowser("boss@example.com")
	e.seedAdmin()
	resp, body := e.get(c, "/admin/waitlist.csv")
	if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/csv") {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil || len(rows) != 8 {
		t.Fatalf("%v rows %d: %q", err, len(rows), body)
	}
	if strings.Join(rows[0], ",") != "email,source,created_at" || strings.Join(rows[1], ",") != "a@example.com,home,2026-11-24T01:00:00Z" {
		t.Fatalf("rows: %v", rows[:2])
	}
	// An address that starts like a formula must not run in a spreadsheet.
	if rows[1+6][0] != "'=cmd@example.com" {
		t.Fatalf("formula cell: %q", rows[7][0])
	}
}
