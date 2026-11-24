package store

import (
	"fmt"
	"time"
)

// WaitlistEntry is one address on the waitlist. Nothing else is kept about the person.
type WaitlistEntry struct {
	Email     string    `json:"email"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// AddWaitlist puts an address on the list. An address already there is not an error: added is false and nothing changes.
func (s *Store) AddWaitlist(email, source string, now time.Time) (added bool, err error) {
	res, err := s.exec("INSERT INTO waitlist(email,source,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING", email, source, ts(now))
	if err != nil {
		return false, fmt.Errorf("store: adding to the waitlist: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// EachWaitlist calls fn for every address, oldest first, without holding the list in memory.
func (s *Store) EachWaitlist(fn func(WaitlistEntry) error) error {
	rows, err := s.query("SELECT email,source,created_at FROM waitlist ORDER BY id")
	if err != nil {
		return fmt.Errorf("store: reading the waitlist: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		e, err := scanWaitlist(rows)
		if err != nil {
			return err
		}
		if err := fn(e); err != nil {
			return err
		}
	}
	return rows.Err()
}

func scanWaitlist(sc interface{ Scan(...any) error }) (WaitlistEntry, error) {
	var e WaitlistEntry
	var at int64
	if err := sc.Scan(&e.Email, &e.Source, &at); err != nil {
		return e, fmt.Errorf("store: reading the waitlist: %w", err)
	}
	e.CreatedAt = time.Unix(at, 0).UTC()
	return e, nil
}

type DayCount struct {
	Day   string `json:"day"` // YYYY-MM-DD, UTC
	Count int64  `json:"count"`
}

type AccountRow struct {
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	Google    bool      `json:"google"`   // linked to a Google account
	Password  bool      `json:"password"` // can sign in with a password
}

type UsageTotals struct {
	Requests int64 `json:"requests"`
	Input    int64 `json:"input_tokens"`
	Output   int64 `json:"output_tokens"`
}

type TopUser struct {
	Email string `json:"email"`
	UsageTotals
}

// AdminStats is everything the admin page and /api/admin/stats show. Days are UTC calendar days.
type AdminStats struct {
	WaitlistTotal  int64           `json:"waitlist_total"`
	WaitlistToday  int64           `json:"waitlist_today"`
	WaitlistWeek   int64           `json:"waitlist_7_days"` // today and the six days before
	WaitlistDays   []DayCount      `json:"waitlist_days"`   // last 14 days, newest first, zeros included
	WaitlistNewest []WaitlistEntry `json:"waitlist_newest"` // up to 200

	AccountsTotal  int64        `json:"accounts_total"`
	AccountsNewest []AccountRow `json:"accounts_newest"` // up to 50
	TokensActive   int64        `json:"tokens_active"`

	UsageToday UsageTotals `json:"usage_today"`
	UsageWeek  UsageTotals `json:"usage_7_days"`
	TopToday   []TopUser   `json:"top_accounts_today"` // up to 10 by tokens

	CommunityGames    int64 `json:"community_games"`
	CommunityVersions int64 `json:"community_versions"`

	DBKind        string `json:"db_kind"`
	SchemaVersion int64  `json:"schema_version"`
}

// AdminStats gathers the numbers for the admin views as of now.
func (s *Store) AdminStats(now time.Time) (AdminStats, error) {
	var a AdminStats
	fail := func(what string, err error) (AdminStats, error) {
		return AdminStats{}, fmt.Errorf("store: admin stats (%s): %w", what, err)
	}
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	weekStart, fortnight := today.AddDate(0, 0, -6), today.AddDate(0, 0, -13)

	one := func(dst *int64, q string, args ...any) error { return s.queryRow(q, args...).Scan(dst) }
	if err := one(&a.WaitlistTotal, "SELECT COUNT(*) FROM waitlist"); err != nil {
		return fail("waitlist total", err)
	}
	if err := one(&a.WaitlistToday, "SELECT COUNT(*) FROM waitlist WHERE created_at>=?", ts(today)); err != nil {
		return fail("waitlist today", err)
	}
	if err := one(&a.WaitlistWeek, "SELECT COUNT(*) FROM waitlist WHERE created_at>=?", ts(weekStart)); err != nil {
		return fail("waitlist week", err)
	}
	// Whole days since the epoch, grouped in SQL (integer division on both databases) and named in Go.
	rows, err := s.query("SELECT created_at/86400, COUNT(*) FROM waitlist WHERE created_at>=? GROUP BY created_at/86400", ts(fortnight))
	if err != nil {
		return fail("waitlist days", err)
	}
	byDay := map[int64]int64{}
	for rows.Next() {
		var d, n int64
		if err := rows.Scan(&d, &n); err != nil {
			rows.Close()
			return fail("waitlist days", err)
		}
		byDay[d] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fail("waitlist days", err)
	}
	for i := 0; i < 14; i++ {
		d := today.AddDate(0, 0, -i)
		a.WaitlistDays = append(a.WaitlistDays, DayCount{Day: d.Format("2006-01-02"), Count: byDay[d.Unix()/86400]})
	}

	rows, err = s.query("SELECT email,source,created_at FROM waitlist ORDER BY id DESC LIMIT 200")
	if err != nil {
		return fail("waitlist newest", err)
	}
	for rows.Next() {
		e, err := scanWaitlist(rows)
		if err != nil {
			rows.Close()
			return AdminStats{}, err
		}
		a.WaitlistNewest = append(a.WaitlistNewest, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fail("waitlist newest", err)
	}

	if err := one(&a.AccountsTotal, "SELECT COUNT(*) FROM users"); err != nil {
		return fail("accounts total", err)
	}
	rows, err = s.query("SELECT email,created_at,CASE WHEN COALESCE(google_sub,'')<>'' THEN 1 ELSE 0 END,CASE WHEN password_hash<>'' THEN 1 ELSE 0 END FROM users ORDER BY created_at DESC, id DESC LIMIT 50")
	if err != nil {
		return fail("accounts newest", err)
	}
	for rows.Next() {
		var r AccountRow
		var at, g, p int64
		if err := rows.Scan(&r.Email, &at, &g, &p); err != nil {
			rows.Close()
			return fail("accounts newest", err)
		}
		r.CreatedAt, r.Google, r.Password = time.Unix(at, 0).UTC(), g != 0, p != 0
		a.AccountsNewest = append(a.AccountsNewest, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fail("accounts newest", err)
	}
	if err := one(&a.TokensActive, "SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL"); err != nil {
		return fail("tokens", err)
	}

	for _, u := range []struct {
		dst   *UsageTotals
		since time.Time
	}{{&a.UsageToday, today}, {&a.UsageWeek, weekStart}} {
		err := s.queryRow("SELECT COUNT(*),CAST(COALESCE(SUM(input_tokens),0) AS BIGINT),CAST(COALESCE(SUM(output_tokens),0) AS BIGINT) FROM usage WHERE created_at>=?",
			ts(u.since)).Scan(&u.dst.Requests, &u.dst.Input, &u.dst.Output)
		if err != nil {
			return fail("usage", err)
		}
	}
	rows, err = s.query(`SELECT u.email,COUNT(*),CAST(SUM(g.input_tokens) AS BIGINT),CAST(SUM(g.output_tokens) AS BIGINT)
		FROM usage g JOIN users u ON u.id=g.user_id WHERE g.created_at>=?
		GROUP BY u.id,u.email ORDER BY SUM(g.input_tokens+g.output_tokens) DESC, u.email LIMIT 10`, ts(today))
	if err != nil {
		return fail("top accounts", err)
	}
	for rows.Next() {
		var t TopUser
		if err := rows.Scan(&t.Email, &t.Requests, &t.Input, &t.Output); err != nil {
			rows.Close()
			return fail("top accounts", err)
		}
		a.TopToday = append(a.TopToday, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fail("top accounts", err)
	}

	if err := one(&a.CommunityGames, "SELECT COUNT(DISTINCT game_id) FROM community_versions"); err != nil {
		return fail("community games", err)
	}
	if err := one(&a.CommunityVersions, "SELECT COUNT(*) FROM community_versions"); err != nil {
		return fail("community versions", err)
	}
	a.DBKind = s.Kind()
	if a.SchemaVersion, err = s.SchemaVersion(); err != nil {
		return fail("schema version", err)
	}
	return a, nil
}
