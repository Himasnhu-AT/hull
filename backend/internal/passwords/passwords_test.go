package passwords

import "testing"

func TestHashVerify(t *testing.T) {
	p := Params{Time: 1, Memory: 8, Threads: 1}
	h1, err := Hash("correct horse", p)
	if err != nil {
		t.Fatal(err)
	}
	h2, _ := Hash("correct horse", p)
	if h1 == h2 {
		t.Error("salts must differ per hash")
	}
	if !Verify("correct horse", h1) || Verify("correct hors", h1) {
		t.Error("verify wrong")
	}
	for _, bad := range []string{"", "x", "$argon2id$v=19$m=8,t=1,p=1$!!$!!", "$argon2i$v=19$m=8,t=1,p=1$aaaa$bbbb"} {
		if Verify("correct horse", bad) {
			t.Errorf("malformed hash %q verified", bad)
		}
	}
}
