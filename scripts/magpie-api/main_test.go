package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, pkg := range []string{"gateway", "gui", "provider", "library", "catalog", "usage"} {
		dir := filepath.Join(root, "internal", pkg)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "empty.go"), []byte("package "+pkg), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func put(t *testing.T, root, name, source string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "internal", name), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRoutesAndJSONShapes(t *testing.T) {
	root := fixture(t)
	put(t, root, "provider/signin.go", `package provider
const Other = "other"
type SignInState struct { ID string `+"`json:\"id\"`"+`; Code string `+"`json:\"code,omitempty\"`"+`; Hidden string `+"`json:\"-\"`"+`; private string }
type signInFlow struct {}
func (s *signInFlow) begin() { switch agent { case "codex", Other: } }
func StartSignIn(a string) (SignInState, error) { return SignInState{}, nil }`)
	put(t, root, "gui/api.go", `package gui
func routes() {
// mux.HandleFunc("POST /fake-comment", ...)
mux.HandleFunc("POST /api/signin", func(w W, r R) {
var in struct { Agent string; Site string `+"`json:\"site,omitempty\"`"+` }
json.NewDecoder(r.Body).Decode(&in)
st, err := provider.StartSignIn(in.Agent)
writeJSON(w, st)
})
mux.HandleFunc("POST /api/login/{action}", func(w W, r R) { switch r.PathValue("action") { case "on", "off": } })
}`)
	put(t, root, "gateway/api.go", `package gateway
const Prefix = "/backend"
func routes() { mux.HandleFunc(Prefix+"/", s.backend) }`)
	put(t, root, "gui/ignored_test.go", `package gui
func fake() { mux.HandleFunc("GET /api/fake-test", nil) }`)
	out, err := extract(root, strings.Repeat("a", 40))
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Routes) != 3 || strings.Join(out.LoginAgents, ",") != "codex,other" {
		t.Fatalf("incorrect extraction: %+v", out)
	}
	for _, r := range out.Routes {
		if r.Path == "/api/signin" {
			if r.Request.Kind != "object" || len(r.Request.Fields) != 2 || !r.Request.Fields[1].Optional ||
				strings.Join(r.ResponseTypes, ",") != "provider.SignInState" {
				t.Fatalf("signin shapes: %+v", r)
			}
		}
		if r.Path == "/api/login/{action}" && strings.Join(r.Actions, ",") != "off,on" {
			t.Fatalf("actions: %+v", r)
		}
	}
	s := out.Schemas["provider.SignInState"]
	if len(s.Fields) != 2 || s.Fields[0].Name != "id" || !s.Fields[1].Optional {
		t.Fatalf("JSON tags: %+v", s)
	}
}

func TestConstraintsUnknownPatternsAndCommentStability(t *testing.T) {
	root := fixture(t)
	source := `//go:build dev
package gui
func routes() { mux.HandleFunc("GET /api/dev", func(w W, r R) {}); mux.HandleFunc(dynamic(), nil) }`
	put(t, root, "gui/dev.go", source)
	before, err := extract(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	put(t, root, "gui/dev.go", source+"\n// a comment, not an API change\n")
	after, err := extract(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	if before.Routes[0].BuildConstraint != "dev" || len(before.Diagnostics) != 1 ||
		before.SourceFiles["internal/gui/dev.go"] != after.SourceFiles["internal/gui/dev.go"] {
		t.Fatal("constraints, diagnostics or semantic hashing failed")
	}
}

func TestUnsupportedWireShapesFailConservatively(t *testing.T) {
	root := fixture(t)
	put(t, root, "provider/types.go", `package provider
type Embedded struct { Other }
type Custom struct { Exposed string }
func (c Custom) MarshalJSON() ([]byte, error) { return nil, nil }`)
	out, err := extract(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Embedded", "Custom"} {
		if out.Schemas["provider."+name].Kind != "unknown" {
			t.Fatal("unsupported wire shapes must not be invented")
		}
	}
}

func TestGeminiActionsAndNullableCollections(t *testing.T) {
	root := fixture(t)
	put(t, root, "gateway/api.go", `package gateway
type Response struct { Rows []string; Labels map[string]int; Fixed [2]string; Bytes []byte; FixedBytes [2]byte }
type Server struct {}
func routes() { mux.HandleFunc("POST /v1beta/models/{call...}", s.gemini) }
func (s *Server) gemini() { switch method { case "generateContent", "streamGenerateContent", "countTokens": } }`)
	out, err := extract(root, "test")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(out.Routes[0].Actions, ",") != "countTokens,generateContent,streamGenerateContent" {
		t.Fatalf("missing Gemini actions: %+v", out.Routes[0])
	}
	fields := out.Schemas["gateway.Response"].Fields
	if fields[0].Type.Kind != "nullable" || fields[1].Type.Kind != "nullable" || fields[2].Type.Kind != "array" {
		t.Fatalf("nil slices and maps can marshal as null: %+v", fields)
	}
	if fields[3].Type.Items.Kind != "string" || fields[4].Type.Items.Kind != "number" {
		t.Fatal("byte slices are base64 strings; fixed byte arrays are numeric arrays")
	}
}

func TestRejectsSourceSymlinks(t *testing.T) {
	root := fixture(t)
	name := filepath.Join(root, "internal", "gui", "link.go")
	if err := os.Symlink(filepath.Join(root, "internal", "gui", "empty.go"), name); err != nil {
		t.Fatal(err)
	}
	if _, err := extract(root, "test"); err == nil {
		t.Fatal("source symlink was accepted")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "internal", "gui")
	if err := os.Rename(dir, dir+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir+"-original", dir); err != nil {
		t.Fatal(err)
	}
	if _, err := extract(root, "test"); err == nil {
		t.Fatal("package directory symlink was accepted")
	}
}
