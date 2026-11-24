package server

import (
	"html/template"
	"net/http"
)

// One light theme for every page, inline so the server stays a single binary with no assets.
const layout = `{{define "layout"}}<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}} - Hull</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f2ee;color:#1c1b18;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:420px}main.wide{max-width:640px}main.xwide{max-width:1000px}
.brand{font-weight:700;letter-spacing:.02em;margin:0 0 16px 4px}
.card{background:#fff;border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(28,27,24,.06);margin-bottom:16px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:0 0 12px}
label{display:block;font-size:14px;margin:14px 0 6px}
input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid #d9d7cf;border-radius:10px;font:inherit;background:#fff;color:inherit}
input:focus{outline:2px solid #1c1b18;outline-offset:1px}
button{font:inherit;cursor:pointer;border-radius:10px;padding:10px 16px;border:1px solid #1c1b18;background:#1c1b18;color:#fff}
button.ghost{background:#fff;color:#1c1b18;border-color:#d9d7cf}
button.small{padding:4px 10px;font-size:14px}
.row{display:flex;gap:8px;margin-top:20px}.row form{margin:0}
.full{width:100%;margin-top:20px}
a.gbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:10px 16px;border:1px solid #d9d7cf;border-radius:999px;background:#fff;color:#1c1b18;text-decoration:none}
a.gbtn:hover{background:#faf9f6}a.gbtn svg{width:18px;height:18px;flex:none}
.or{display:flex;align-items:center;gap:12px;color:#6b695f;font-size:14px;margin:16px 0 0}.or:before,.or:after{content:"";flex:1;border-top:1px solid #eceae3}
.error{background:#fbeceb;color:#8a1f17;border-radius:10px;padding:10px 12px;margin:0 0 12px;font-size:14px}
.muted{color:#6b695f;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 16px}.num{text-align:right}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 4px;border-top:1px solid #eceae3}th{border-top:0;color:#6b695f;font-weight:500}
.nums{display:flex;gap:24px}.nums b{display:block;font-size:22px}
code{background:#f3f2ee;border-radius:6px;padding:1px 6px;font-size:14px}
a{color:#1c1b18}
</style></head><body><main{{if .XWide}} class="xwide"{{else if .Wide}} class="wide"{{end}}><p class="brand">Hull</p>{{template "body" .}}</main></body></html>{{end}}`

const authBody = `{{define "body"}}<div class="card"><h1>{{.Title}}</h1>
{{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
{{if .Closed}}<p class="muted">Sign-up is closed on this server.</p>{{else}}
{{if .Google}}<a class="gbtn" href="{{.GoogleHref}}"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>Continue with Google</a>
<p class="or">or</p>{{end}}
<form method="post" action="{{.Action}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="next" value="{{.Next}}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="{{.Email}}">
<label for="password">Password</label><input id="password" name="password" type="password" required minlength="{{.MinLen}}" autocomplete="{{.AutoComplete}}">
{{if .Signup}}<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required autocomplete="new-password">
<p class="muted">At least 10 characters.</p>{{end}}
<button class="full" type="submit">{{.Title}}</button></form>{{end}}</div>
<p class="muted">{{.Alt}} <a href="{{.AltHref}}">{{.AltLabel}}</a></p>{{end}}`

const accountBody = `{{define "body"}}<div class="card"><h1>Account</h1><p>{{.Email}}</p>{{if .GoogleLinked}}<p class="muted">Signed in with Google</p>{{end}}
<form method="post" action="/logout"><input type="hidden" name="csrf" value="{{.CSRF}}"><button class="ghost" type="submit">Log out</button></form></div>
<div class="card"><h2>Usage this month</h2><div class="nums"><div><b>{{.Input}}</b><span class="muted">input tokens</span></div><div><b>{{.Output}}</b><span class="muted">output tokens</span></div></div></div>
<div class="card"><h2>Apps signed in</h2>
{{if .Tokens}}<table><tr><th>App</th><th>Created</th><th>Last used</th><th></th></tr>
{{range .Tokens}}<tr><td>{{.Name}}</td><td>{{.Created}}</td><td>{{.LastUsed}}</td><td>
<form method="post" action="/tokens/{{.ID}}/revoke"><input type="hidden" name="csrf" value="{{$.CSRF}}"><button class="ghost small" type="submit">Revoke</button></form></td></tr>{{end}}</table>
{{else}}<p class="muted">No apps are signed in.</p>{{end}}</div>{{end}}`

const consentBody = `{{define "body"}}<div class="card"><h1>Allow {{.Client}} to use your account?</h1>
<p>You are signed in as <b>{{.Email}}</b>. {{.Client}} will be able to use Hull's AI on your account until you revoke it from your account page.</p>
<p class="muted">It will receive the sign-in on your computer at {{.Target}}.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="csrf" value="{{.CSRF}}">
{{range .Hidden}}<input type="hidden" name="{{.Name}}" value="{{.Value}}">{{end}}
<div class="row"><button type="submit" name="decision" value="allow">Allow</button><button class="ghost" type="submit" name="decision" value="deny">Cancel</button></div></form></div>{{end}}`

const adminBody = `{{define "body"}}{{with .Admin}}
<div class="card"><h1>Waitlist</h1><div class="nums"><div><b>{{.Stats.WaitlistTotal}}</b><span class="muted">total</span></div><div><b>{{.Stats.WaitlistToday}}</b><span class="muted">today (UTC)</span></div><div><b>{{.Stats.WaitlistWeek}}</b><span class="muted">last 7 days</span></div></div>
<p class="muted"><a href="/admin/waitlist.csv">Download all as CSV</a></p></div>
<div class="grid"><div class="card"><h2>Last 14 days</h2><table><tr><th>Day (UTC)</th><th class="num">Sign-ups</th></tr>
{{range .Stats.WaitlistDays}}<tr><td>{{.Day}}</td><td class="num">{{.Count}}</td></tr>{{end}}</table></div>
<div class="card"><h2>Accounts, tokens, community</h2><div class="nums"><div><b>{{.Stats.AccountsTotal}}</b><span class="muted">accounts</span></div><div><b>{{.Stats.TokensActive}}</b><span class="muted">active tokens</span></div></div>
<div class="nums" style="margin-top:16px"><div><b>{{.Stats.CommunityGames}}</b><span class="muted">community games</span></div><div><b>{{.Stats.CommunityVersions}}</b><span class="muted">versions</span></div></div></div></div>
<div class="card"><h2>AI usage</h2><table><tr><th></th><th class="num">Requests</th><th class="num">Input tokens</th><th class="num">Output tokens</th></tr>
<tr><td>Today</td><td class="num">{{.Stats.UsageToday.Requests}}</td><td class="num">{{.Stats.UsageToday.Input}}</td><td class="num">{{.Stats.UsageToday.Output}}</td></tr>
<tr><td>Last 7 days</td><td class="num">{{.Stats.UsageWeek.Requests}}</td><td class="num">{{.Stats.UsageWeek.Input}}</td><td class="num">{{.Stats.UsageWeek.Output}}</td></tr></table>
<h2 style="margin-top:20px">Top accounts today</h2>
{{if .Top}}<table><tr><th>Account</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th></tr>
{{range .Top}}<tr><td>{{.Email}}</td><td class="num">{{.Requests}}</td><td class="num">{{.Input}}</td><td class="num">{{.Output}}</td></tr>{{end}}</table>{{else}}<p class="muted">No AI use yet today.</p>{{end}}</div>
<div class="card"><h2>Newest waitlist addresses ({{len .Waitlist}})</h2>
{{if .Waitlist}}<table><tr><th>Email</th><th>Source</th><th>Joined (UTC)</th></tr>
{{range .Waitlist}}<tr><td>{{.Email}}</td><td>{{.Source}}</td><td>{{.At}}</td></tr>{{end}}</table>{{else}}<p class="muted">Nobody yet.</p>{{end}}</div>
<div class="card"><h2>Newest accounts ({{len .Accounts}} of {{.Stats.AccountsTotal}})</h2>
{{if .Accounts}}<table><tr><th>Email</th><th>Created (UTC)</th><th>Sign-in</th></tr>
{{range .Accounts}}<tr><td>{{.Email}}</td><td>{{.At}}</td><td>{{.How}}</td></tr>{{end}}</table>{{else}}<p class="muted">No accounts.</p>{{end}}</div>
<div class="card"><h2>System</h2><table>
<tr><td>Database</td><td>{{.System.DBKind}} <span class="muted">{{.System.DBWhere}}</span></td></tr>
<tr><td>Schema version</td><td>{{.System.SchemaVersion}}</td></tr>
<tr><td>Server started</td><td>{{.System.StartedAt}}</td></tr>
<tr><td>Go</td><td>{{.System.GoVersion}}</td></tr></table></div>
{{end}}{{end}}`

const messageBody = `{{define "body"}}<div class="card"><h1>{{.Title}}</h1><p>{{.Error}}</p></div>{{end}}`

var pages = map[string]*template.Template{}

func init() {
	for name, body := range map[string]string{"auth": authBody, "account": accountBody, "consent": consentBody, "message": messageBody, "admin": adminBody} {
		pages[name] = template.Must(template.Must(template.New(name).Parse(layout)).Parse(body))
	}
}

type field struct{ Name, Value string }

type tokenRow struct {
	ID                      int64
	Name, Created, LastUsed string
}

type pageData struct {
	Title, Error, CSRF, Next, Email string
	Wide, XWide, Closed, Signup     bool
	Admin                           *adminView
	Google, GoogleLinked            bool
	GoogleHref                      string
	Action, Alt, AltHref, AltLabel  string
	MinLen                          int
	AutoComplete                    string
	Tokens                          []tokenRow
	Input, Output                   int64
	Client, Target                  string
	Hidden                          []field
}

func (s *Server) render(w http.ResponseWriter, status int, name string, d pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
	w.WriteHeader(status)
	if err := pages[name].ExecuteTemplate(w, "layout", d); err != nil {
		s.log.Error("rendering page", "page", name, "err", err)
	}
}

func (s *Server) message(w http.ResponseWriter, status int, title, text string) {
	s.render(w, status, "message", pageData{Title: title, Error: text})
}

var _ = http.StatusOK
