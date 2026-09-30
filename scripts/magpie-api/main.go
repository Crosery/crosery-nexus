// Extract source contracts without importing or running upstream packages.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

type schema struct {
	Kind   string  `json:"kind"`
	Ref    string  `json:"ref,omitempty"`
	Fields []field `json:"fields,omitempty"`
	Items  *schema `json:"items,omitempty"`
	GoType string  `json:"goType,omitempty"`
}

type field struct {
	Name     string `json:"name"`
	Optional bool   `json:"optional"`
	Type     schema `json:"type"`
}

type route struct {
	Surface         string   `json:"surface"`
	Method          string   `json:"method"`
	Path            string   `json:"path"`
	Handler         string   `json:"handler"`
	Source          string   `json:"source"`
	BuildConstraint string   `json:"buildConstraint,omitempty"`
	Request         schema   `json:"request"`
	ResponseTypes   []string `json:"responseTypes"`
	Actions         []string `json:"actions"`
	QueryParameters []string `json:"queryParameters"`
	HandlerHash     string   `json:"handlerHash"`
}

type contract struct {
	Version     int               `json:"version"`
	Revision    string            `json:"revision"`
	Routes      []route           `json:"routes"`
	Schemas     map[string]schema `json:"schemas"`
	LoginAgents []string          `json:"loginAgents"`
	SourceFiles map[string]string `json:"sourceFiles"`
	Diagnostics []string          `json:"diagnostics"`
}

type sourceFile struct {
	tree       *ast.File
	name, pkg  string
	constraint string
}

type extractor struct {
	fset      *token.FileSet
	files     []sourceFile
	constants map[string]ast.Expr
	functions map[string]*ast.FuncDecl
	out       contract
}

func text(n ast.Node) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, token.NewFileSet(), n)
	return b.String()
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func (e *extractor) value(n ast.Expr, pkg string, depth int) (string, bool) {
	if depth > 20 {
		return "", false
	}
	switch x := n.(type) {
	case *ast.BasicLit:
		if x.Kind == token.STRING {
			s, err := strconv.Unquote(x.Value)
			return s, err == nil
		}
	case *ast.Ident:
		if v, ok := e.constants[pkg+"."+x.Name]; ok {
			return e.value(v, pkg, depth+1)
		}
	case *ast.BinaryExpr:
		if x.Op == token.ADD {
			a, okA := e.value(x.X, pkg, depth+1)
			b, okB := e.value(x.Y, pkg, depth+1)
			return a + b, okA && okB
		}
	}
	return "", false
}

func (e *extractor) shape(n ast.Expr, pkg string) schema {
	switch x := n.(type) {
	case *ast.Ident:
		switch x.Name {
		case "string":
			return schema{Kind: "string"}
		case "bool":
			return schema{Kind: "boolean"}
		case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64":
			return schema{Kind: "number"}
		case "any", "error":
			return schema{Kind: "unknown", GoType: x.Name}
		default:
			return schema{Kind: "ref", Ref: pkg + "." + x.Name}
		}
	case *ast.SelectorExpr:
		if text(x) == "time.Time" {
			return schema{Kind: "string", GoType: "time.Time"}
		}
		if text(x) == "json.RawMessage" {
			return schema{Kind: "unknown", GoType: "json.RawMessage"}
		}
		return schema{Kind: "ref", Ref: text(x)}
	case *ast.StarExpr:
		item := e.shape(x.X, pkg)
		return schema{Kind: "nullable", Items: &item}
	case *ast.ArrayType:
		if x.Len == nil && (text(x.Elt) == "byte" || text(x.Elt) == "uint8") {
			item := schema{Kind: "string", GoType: "base64 bytes"}
			return schema{Kind: "nullable", Items: &item}
		}
		if text(x.Elt) == "byte" {
			item := schema{Kind: "number"}
			return schema{Kind: "array", Items: &item}
		}
		item := e.shape(x.Elt, pkg)
		array := schema{Kind: "array", Items: &item}
		if x.Len == nil {
			return schema{Kind: "nullable", Items: &array}
		}
		return array
	case *ast.MapType:
		item := e.shape(x.Value, pkg)
		mapping := schema{Kind: "map", Items: &item}
		return schema{Kind: "nullable", Items: &mapping}
	case *ast.StructType:
		s := schema{Kind: "object", Fields: []field{}}
		for _, f := range x.Fields.List {
			if len(f.Names) == 0 {
				// Embedding and custom marshaling need wire-level verification.
				return schema{Kind: "unknown", GoType: "embedded " + text(x)}
			}
			tag := ""
			if f.Tag != nil {
				t, _ := strconv.Unquote(f.Tag.Value)
				tag = reflect.StructTag(t).Get("json")
			}
			parts := strings.Split(tag, ",")
			if parts[0] == "-" {
				continue
			}
			for _, name := range f.Names {
				if !name.IsExported() {
					continue
				}
				wireName := name.Name
				if parts[0] != "" {
					wireName = parts[0]
				}
				typ := e.shape(f.Type, pkg)
				optional := false
				for _, option := range parts[1:] {
					optional = optional || option == "omitempty" || option == "omitzero"
					if option == "string" {
						typ = schema{Kind: "string", GoType: text(f.Type)}
					}
				}
				s.Fields = append(s.Fields, field{Name: wireName, Optional: optional, Type: typ})
			}
		}
		return s
	}
	return schema{Kind: "unknown", GoType: text(n)}
}

func functionKey(f *ast.FuncDecl, pkg string) string {
	if f.Recv != nil {
		return pkg + "." + strings.TrimPrefix(text(f.Recv.List[0].Type), "*") + "." + f.Name.Name
	}
	return pkg + "." + f.Name.Name
}

func (e *extractor) callResult(c *ast.CallExpr, pkg string) string {
	key := text(c.Fun)
	if id, ok := c.Fun.(*ast.Ident); ok {
		key = pkg + "." + id.Name
	}
	f := e.functions[key]
	if f == nil || f.Type.Results == nil || len(f.Type.Results.List) == 0 {
		return ""
	}
	p := strings.Split(key, ".")[0]
	s := e.shape(f.Type.Results.List[0].Type, p)
	if s.Kind == "nullable" {
		s = *s.Items
	}
	if s.Kind == "ref" {
		return s.Ref
	}
	return ""
}

func unique(values []string) []string {
	sort.Strings(values)
	out := []string{}
	for _, v := range values {
		if len(out) == 0 || out[len(out)-1] != v {
			out = append(out, v)
		}
	}
	return out
}

func (e *extractor) inspectRoute(r *route, body ast.Node, pkg string) {
	var types = map[string]schema{}
	var results = map[string]string{}
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.ValueSpec:
			if x.Type != nil {
				for _, name := range x.Names {
					types[name.Name] = e.shape(x.Type, pkg)
				}
			}
		case *ast.AssignStmt:
			if len(x.Rhs) == 1 && len(x.Lhs) > 0 {
				if c, ok := x.Rhs[0].(*ast.CallExpr); ok {
					if id, ok := x.Lhs[0].(*ast.Ident); ok {
						results[id.Name] = e.callResult(c, pkg)
					}
				}
			}
		case *ast.CallExpr:
			if s, ok := x.Fun.(*ast.SelectorExpr); ok {
				if s.Sel.Name == "Decode" && len(x.Args) == 1 {
					if unary, ok := x.Args[0].(*ast.UnaryExpr); ok && unary.Op == token.AND {
						if id, ok := unary.X.(*ast.Ident); ok {
							if typ, found := types[id.Name]; found {
								r.Request = typ
							}
						}
					}
				}
				if s.Sel.Name == "Get" && strings.Contains(text(s.X), ".URL.Query()") && len(x.Args) == 1 {
					if name, ok := e.value(x.Args[0], pkg, 0); ok {
						r.QueryParameters = append(r.QueryParameters, name)
					}
				}
			}
			if text(x.Fun) == "writeJSON" && len(x.Args) == 2 {
				switch v := x.Args[1].(type) {
				case *ast.Ident:
					if results[v.Name] != "" {
						r.ResponseTypes = append(r.ResponseTypes, results[v.Name])
					}
				case *ast.CallExpr:
					if typ := e.callResult(v, pkg); typ != "" {
						r.ResponseTypes = append(r.ResponseTypes, typ)
					}
				}
			}
		case *ast.SwitchStmt:
			if x.Tag != nil && (strings.Contains(text(x.Tag), `PathValue("action")`) ||
				(pkg == "gateway" && text(x.Tag) == "method")) {
				for _, clause := range x.Body.List {
					for _, v := range clause.(*ast.CaseClause).List {
						if action, ok := e.value(v, pkg, 0); ok {
							r.Actions = append(r.Actions, action)
						}
					}
				}
			}
		}
		return true
	})
	r.ResponseTypes = unique(r.ResponseTypes)
	r.Actions = unique(r.Actions)
	r.QueryParameters = unique(r.QueryParameters)
}

func extract(root, revision string) (contract, error) {
	e := &extractor{fset: token.NewFileSet(), constants: map[string]ast.Expr{}, functions: map[string]*ast.FuncDecl{},
		out: contract{Version: 1, Revision: revision, Routes: []route{}, Schemas: map[string]schema{},
			LoginAgents: []string{}, SourceFiles: map[string]string{}, Diagnostics: []string{}}}
	for _, pkg := range []string{"gateway", "gui", "provider", "library", "catalog", "usage"} {
		dir := filepath.Join(root, "internal", pkg)
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return contract{}, fmt.Errorf("invalid source directory: internal/%s", pkg)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return contract{}, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
				continue
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return contract{}, fmt.Errorf("refusing source symlink: %s", entry.Name())
			}
			name := filepath.ToSlash(filepath.Join("internal", pkg, entry.Name()))
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() || info.Size() > 2<<20 {
				return contract{}, fmt.Errorf("invalid source file: %s", name)
			}
			data, err := os.ReadFile(filepath.Join(root, name))
			if err != nil {
				return contract{}, err
			}
			if len(data) > 2<<20 {
				return contract{}, fmt.Errorf("source file too large: %s", name)
			}
			tree, err := parser.ParseFile(e.fset, name, data, 0)
			if err != nil {
				return contract{}, err
			}
			constraint := ""
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "//go:build ") {
					constraint = strings.TrimPrefix(line, "//go:build ")
				}
			}
			e.files = append(e.files, sourceFile{tree, name, pkg, constraint})
			e.out.SourceFiles[name] = hash(text(tree) + constraint)
			for _, decl := range tree.Decls {
				if f, ok := decl.(*ast.FuncDecl); ok {
					e.functions[functionKey(f, pkg)] = f
				}
				if g, ok := decl.(*ast.GenDecl); ok {
					for _, spec := range g.Specs {
						if v, ok := spec.(*ast.ValueSpec); ok && g.Tok == token.CONST {
							for i, name := range v.Names {
								if i < len(v.Values) {
									e.constants[pkg+"."+name.Name] = v.Values[i]
								}
							}
						}
					}
				}
			}
		}
	}
	for _, file := range e.files {
		for _, decl := range file.tree.Decls {
			if g, ok := decl.(*ast.GenDecl); ok && g.Tok == token.TYPE {
				for _, spec := range g.Specs {
					t := spec.(*ast.TypeSpec)
					key := file.pkg + "." + t.Name.Name
					e.out.Schemas[key] = e.shape(t.Type, file.pkg)
					if _, custom := e.functions[file.pkg+"."+t.Name.Name+".MarshalJSON"]; custom {
						e.out.Schemas[key] = schema{Kind: "unknown", GoType: "custom MarshalJSON"}
					}
				}
			}
		}
		if f := e.functions["provider.signInFlow.begin"]; f != nil && file.pkg == "provider" && file.name == "internal/provider/signin.go" {
			ast.Inspect(f.Body, func(n ast.Node) bool {
				if s, ok := n.(*ast.SwitchStmt); ok && text(s.Tag) == "agent" {
					for _, clause := range s.Body.List {
						for _, v := range clause.(*ast.CaseClause).List {
							if id, ok := e.value(v, file.pkg, 0); ok {
								e.out.LoginAgents = append(e.out.LoginAgents, id)
							}
						}
					}
				}
				return true
			})
		}
		if file.pkg != "gui" && file.pkg != "gateway" {
			continue
		}
		ast.Inspect(file.tree, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 2 {
				return true
			}
			method, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (method.Sel.Name != "HandleFunc" && method.Sel.Name != "Handle") {
				return true
			}
			pattern, known := e.value(call.Args[0], file.pkg, 0)
			if !known {
				e.out.Diagnostics = append(e.out.Diagnostics, file.name+": unresolved route "+text(call.Args[0]))
				return true
			}
			verb, path := "*", pattern
			if before, after, ok := strings.Cut(pattern, " "); ok {
				verb, path = before, after
			}
			if file.pkg == "gui" && !strings.HasPrefix(path, "/api/") {
				return true
			}
			surface := "management"
			if file.pkg == "gateway" {
				surface = "inference"
			}
			r := route{Surface: surface, Method: verb, Path: path, Handler: text(call.Args[1]),
				Source: file.name, BuildConstraint: file.constraint, Request: schema{Kind: "unknown", GoType: "not statically inferred"},
				ResponseTypes: []string{}, Actions: []string{}, QueryParameters: []string{}}
			var body ast.Node = call.Args[1]
			if fn, ok := call.Args[1].(*ast.FuncLit); ok {
				r.Handler = "inline"
				body = fn.Body
			} else {
				handler := call.Args[1]
				if c, ok := handler.(*ast.CallExpr); ok {
					handler = c.Fun
				}
				if sel, ok := handler.(*ast.SelectorExpr); ok {
					if f, found := e.functions[file.pkg+".Server."+sel.Sel.Name]; found {
						body = f.Body
					}
				}
			}
			r.HandlerHash = hash(text(body))
			e.inspectRoute(&r, body, file.pkg)
			e.out.Routes = append(e.out.Routes, r)
			return true
		})
	}
	sort.Slice(e.out.Routes, func(i, j int) bool {
		a, b := e.out.Routes[i], e.out.Routes[j]
		return a.Surface+a.Method+a.Path+a.Source < b.Surface+b.Method+b.Path+b.Source
	})
	e.out.LoginAgents = unique(e.out.LoginAgents)
	e.out.Diagnostics = unique(e.out.Diagnostics)
	return e.out, nil
}

func main() {
	source := flag.String("source", "", "clean upstream checkout")
	revision := flag.String("revision", "", "upstream commit")
	flag.Parse()
	if *source == "" || *revision == "" {
		fmt.Fprintln(os.Stderr, "source and revision are required")
		os.Exit(1)
	}
	result, err := extract(*source, *revision)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		os.Exit(1)
	}
}
