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
main{width:100%;max-width:420px}main.wide{max-width:640px}
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
.error{background:#fbeceb;color:#8a1f17;border-radius:10px;padding:10px 12px;margin:0 0 12px;font-size:14px}
.muted{color:#6b695f;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 4px;border-top:1px solid #eceae3}th{border-top:0;color:#6b695f;font-weight:500}
.nums{display:flex;gap:24px}.nums b{display:block;font-size:22px}
code{background:#f3f2ee;border-radius:6px;padding:1px 6px;font-size:14px}
a{color:#1c1b18}
</style></head><body><main{{if .Wide}} class="wide"{{end}}><p class="brand">Hull</p>{{template "body" .}}</main></body></html>{{end}}`

const authBody = `{{define "body"}}<div class="card"><h1>{{.Title}}</h1>
{{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
{{if .Closed}}<p class="muted">Sign-up is closed on this server.</p>{{else}}
<form method="post" action="{{.Action}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="next" value="{{.Next}}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="{{.Email}}">
<label for="password">Password</label><input id="password" name="password" type="password" required minlength="{{.MinLen}}" autocomplete="{{.AutoComplete}}">
{{if .Signup}}<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" required autocomplete="new-password">
<p class="muted">At least 10 characters.</p>{{end}}
<button class="full" type="submit">{{.Title}}</button></form>{{end}}</div>
<p class="muted">{{.Alt}} <a href="{{.AltHref}}">{{.AltLabel}}</a></p>{{end}}`

const accountBody = `{{define "body"}}<div class="card"><h1>Account</h1><p>{{.Email}}</p>
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

const messageBody = `{{define "body"}}<div class="card"><h1>{{.Title}}</h1><p>{{.Error}}</p></div>{{end}}`

var pages = map[string]*template.Template{}

func init() {
	for name, body := range map[string]string{"auth": authBody, "account": accountBody, "consent": consentBody, "message": messageBody} {
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
	Wide, Closed, Signup            bool
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
