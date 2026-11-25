package server

import (
	"encoding/csv"
	"net/http"
	"runtime"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
)

// admin answers 404, never 401 or a redirect, to everyone who is not a signed-in admin, so the routes do not show
// themselves. An admin signs in at /login first, like anyone else.
//
// An admin is an account in ADMIN_EMAILS that Google has vouched for (it is linked to a Google user). A password
// alone is not enough: sign-up takes any address without proof, so anyone could register an admin's address before
// its owner does.
func (s *Server) admin(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.sessionUser(r)
		if !ok || u.GoogleSub == "" || !s.cfg.IsAdmin(u.Email) {
			http.NotFound(w, r)
			return
		}
		next(w, r)
	}
}

type adminSystem struct {
	DBKind        string `json:"db_kind"`
	DBWhere       string `json:"db_where"`
	SchemaVersion int64  `json:"schema_version"`
	StartedAt     string `json:"started_at"`
	GoVersion     string `json:"go_version"`
}

func (s *Server) adminSystem(st store.AdminStats) adminSystem {
	return adminSystem{DBKind: st.DBKind, DBWhere: s.st.Where(), SchemaVersion: st.SchemaVersion,
		StartedAt: utc(s.started), GoVersion: runtime.Version()}
}

func utc(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05") + " UTC" }

type adminJSON struct {
	store.AdminStats
	System adminSystem `json:"system"`
}

func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	st, err := s.st.AdminStats(s.now())
	if err != nil {
		s.log.Error("admin stats", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	writeJSON(w, http.StatusOK, adminJSON{AdminStats: st, System: s.adminSystem(st)})
}

type adminWaitRow struct{ Email, Source, At string }
type adminAccountRow struct{ Email, At, How string }
type adminTopRow struct {
	Email                   string
	Requests, Input, Output int64
}

type adminView struct {
	Stats    store.AdminStats
	System   adminSystem
	Waitlist []adminWaitRow
	Accounts []adminAccountRow
	Top      []adminTopRow
}

func (s *Server) adminPage(w http.ResponseWriter, r *http.Request) {
	st, err := s.st.AdminStats(s.now())
	if err != nil {
		s.log.Error("admin page", "err", err)
		s.message(w, http.StatusInternalServerError, "Something went wrong", "The numbers could not be read. The server log has the reason.")
		return
	}
	v := &adminView{Stats: st, System: s.adminSystem(st)}
	for _, e := range st.WaitlistNewest {
		v.Waitlist = append(v.Waitlist, adminWaitRow{e.Email, e.Source, utc(e.CreatedAt)})
	}
	for _, a := range st.AccountsNewest {
		how := "password"
		if a.Google && !a.Password {
			how = "Google"
		} else if a.Google {
			how = "password and Google"
		}
		v.Accounts = append(v.Accounts, adminAccountRow{a.Email, utc(a.CreatedAt), how})
	}
	for _, t := range st.TopToday {
		v.Top = append(v.Top, adminTopRow{t.Email, t.Requests, t.Input, t.Output})
	}
	s.render(w, http.StatusOK, "admin", pageData{Title: "Admin", XWide: true, Admin: v})
}

// csvCell stops a spreadsheet from running an address that starts with a formula character.
func csvCell(s string) string {
	if s != "" && (s[0] == '=' || s[0] == '+' || s[0] == '-' || s[0] == '@') {
		return "'" + s
	}
	return s
}

func (s *Server) adminWaitlistCSV(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="waitlist.csv"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	cw := csv.NewWriter(w)
	cw.Write([]string{"email", "source", "created_at"})
	err := s.st.EachWaitlist(func(e store.WaitlistEntry) error {
		return cw.Write([]string{csvCell(e.Email), e.Source, e.CreatedAt.UTC().Format(time.RFC3339)})
	})
	cw.Flush()
	if err != nil {
		// The headers are gone already; the log is the only place left to say the file is short.
		s.log.Error("admin waitlist csv", "err", err)
	}
}
