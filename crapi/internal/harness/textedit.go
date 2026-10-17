package harness

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// ---------- TOML：按行做外科式修改，保留用户其余内容与注释 ----------

// TOMLDoc 是按行保存的 TOML 文本。
type TOMLDoc struct {
	lines []string
	crlf  bool
}

// ParseTOML 读入 TOML 文本（容忍 BOM 与 CRLF）。
func ParseTOML(data []byte) *TOMLDoc {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	s := string(data)
	d := &TOMLDoc{crlf: strings.Contains(s, "\r\n")}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimRight(s, "\n")
	if s != "" {
		d.lines = strings.Split(s, "\n")
	}
	return d
}

// Bytes 输出文本，保持原换行风格。
func (d *TOMLDoc) Bytes() []byte {
	s := strings.Join(d.lines, "\n") + "\n"
	if d.crlf {
		s = strings.ReplaceAll(s, "\n", "\r\n")
	}
	return []byte(s)
}

var tomlHeader = regexp.MustCompile(`^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$`)

// headerAt 返回第 i 行若是表头时的表名。
func (d *TOMLDoc) headerAt(i int) (string, bool) {
	m := tomlHeader.FindStringSubmatch(d.lines[i])
	if m == nil {
		return "", false
	}
	return strings.ReplaceAll(m[1], " ", ""), true
}

// topLevelEnd 返回第一个表头所在行（顶层键区间的结束位置），跳过多行数组/字符串。
func (d *TOMLDoc) topLevelEnd() int {
	depth := 0
	inML := false
	for i, ln := range d.lines {
		if inML {
			if strings.Contains(ln, `"""`) || strings.Contains(ln, `'''`) {
				inML = false
			}
			continue
		}
		if depth == 0 {
			if _, ok := d.headerAt(i); ok {
				return i
			}
		}
		code := stripTOMLComment(ln)
		if strings.Count(code, `"""`)%2 == 1 || strings.Count(code, `'''`)%2 == 1 {
			inML = true
			continue
		}
		depth += bracketDelta(code)
		if depth < 0 {
			depth = 0
		}
	}
	return len(d.lines)
}

func bracketDelta(s string) int {
	n := 0
	inStr := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr != 0 {
			if c == '\\' && inStr == '"' {
				i++
			} else if c == inStr {
				inStr = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			inStr = c
		case '[', '{':
			n++
		case ']', '}':
			n--
		}
	}
	return n
}

func stripTOMLComment(s string) string {
	inStr := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr != 0 {
			if c == '\\' && inStr == '"' {
				i++
			} else if c == inStr {
				inStr = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			inStr = c
		} else if c == '#' {
			return s[:i]
		}
	}
	return s
}

func keyLine(key string) *regexp.Regexp {
	return regexp.MustCompile(`^\s*"?` + regexp.QuoteMeta(key) + `"?\s*=`)
}

// GetTop 读取顶层键的原始值文本（未解析）。
func (d *TOMLDoc) GetTop(key string) (string, bool) {
	re := keyLine(key)
	end := d.topLevelEnd()
	for i := 0; i < end; i++ {
		if re.MatchString(d.lines[i]) {
			v := d.lines[i][strings.Index(d.lines[i], "=")+1:]
			return strings.TrimSpace(stripTOMLComment(v)), true
		}
	}
	return "", false
}

// SetTop 设置顶层键（值为已编码的 TOML 字面量）。键不存在时插到顶层区末尾。
func (d *TOMLDoc) SetTop(key, literal string) {
	re := keyLine(key)
	end := d.topLevelEnd()
	line := key + " = " + literal
	for i := 0; i < end; i++ {
		if re.MatchString(d.lines[i]) {
			d.lines[i] = line
			return
		}
	}
	// 插在顶层区最后一个非空行之后，保持与后面表之间的空行。
	at := end
	for at > 0 && strings.TrimSpace(d.lines[at-1]) == "" {
		at--
	}
	d.lines = append(d.lines[:at], append([]string{line}, d.lines[at:]...)...)
}

// DeleteTop 删除顶层键（仅限单行值）。
func (d *TOMLDoc) DeleteTop(key string) {
	re := keyLine(key)
	end := d.topLevelEnd()
	for i := 0; i < end; i++ {
		if re.MatchString(d.lines[i]) {
			d.lines = append(d.lines[:i], d.lines[i+1:]...)
			return
		}
	}
}

// HasTable 报告是否存在某个表。
func (d *TOMLDoc) HasTable(name string) bool {
	for i := range d.lines {
		if h, ok := d.headerAt(i); ok && h == name {
			return true
		}
	}
	return false
}

// TableValue 读取某个表内某键的原始值文本。
func (d *TOMLDoc) TableValue(table, key string) (string, bool) {
	re := keyLine(key)
	in := false
	for i, ln := range d.lines {
		if h, ok := d.headerAt(i); ok {
			in = h == table
			continue
		}
		if in && re.MatchString(ln) {
			return strings.TrimSpace(stripTOMLComment(ln[strings.Index(ln, "=")+1:])), true
		}
	}
	return "", false
}

// ReplaceTable 用 body 整体替换某个表（含其子表，如 [a.b] 下的 [a.b.c]）；不存在则追加到末尾。
func (d *TOMLDoc) ReplaceTable(name string, body []string) {
	block := append([]string{"[" + name + "]"}, body...)
	start := -1
	for i := range d.lines {
		if h, ok := d.headerAt(i); ok && h == name {
			start = i
			break
		}
	}
	if start < 0 {
		for len(d.lines) > 0 && strings.TrimSpace(d.lines[len(d.lines)-1]) == "" {
			d.lines = d.lines[:len(d.lines)-1]
		}
		if len(d.lines) > 0 {
			d.lines = append(d.lines, "")
		}
		d.lines = append(d.lines, block...)
		return
	}
	end := len(d.lines)
	for i := start + 1; i < len(d.lines); i++ {
		if h, ok := d.headerAt(i); ok && h != name && !strings.HasPrefix(h, name+".") {
			end = i
			break
		}
	}
	// 保留表后原有的空行分隔。
	for end > start+1 && strings.TrimSpace(d.lines[end-1]) == "" {
		end--
	}
	rest := append([]string{}, d.lines[end:]...)
	d.lines = append(append(d.lines[:start], block...), rest...)
}

// RemoveTablesWithPrefix 删除表名以 prefix 开头的所有表（含表体）。
func (d *TOMLDoc) RemoveTablesWithPrefix(prefix string) {
	var out []string
	skip := false
	for i := range d.lines {
		if h, ok := d.headerAt(i); ok {
			skip = strings.HasPrefix(h, prefix)
		}
		if !skip {
			out = append(out, d.lines[i])
		}
	}
	// 合并删除后留下的连续空行。
	var compact []string
	for i, ln := range out {
		if strings.TrimSpace(ln) == "" && i > 0 && strings.TrimSpace(out[i-1]) == "" {
			continue
		}
		compact = append(compact, ln)
	}
	d.lines = compact
}

// TOMLString 编码 TOML 基本字符串。
func TOMLString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`)
	return `"` + r.Replace(s) + `"`
}

// UnquoteTOML 粗略解码简单的 TOML 字符串字面量。
func UnquoteTOML(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		inner := v[1 : len(v)-1]
		if v[0] == '"' {
			inner = strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(inner)
		}
		return inner
	}
	return v
}

// ---------- dotenv ----------

// SetDotenv 在 KEY=VALUE 文本里设置若干键，保留其余行与注释。
func SetDotenv(data []byte, kv [][2]string) []byte {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	s := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := []string{}
	if strings.TrimSpace(s) != "" {
		lines = strings.Split(strings.TrimRight(s, "\n"), "\n")
	}
	for _, p := range kv {
		re := regexp.MustCompile(`^\s*(export\s+)?` + regexp.QuoteMeta(p[0]) + `\s*=`)
		line := p[0] + "=" + dotenvValue(p[1])
		found := false
		for i, ln := range lines {
			if re.MatchString(ln) {
				lines[i] = line
				found = true
			}
		}
		if !found {
			lines = append(lines, line)
		}
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// GetDotenv 读取 dotenv 中的某个键。
func GetDotenv(data []byte, key string) string {
	re := regexp.MustCompile(`^\s*(export\s+)?` + regexp.QuoteMeta(key) + `\s*=(.*)$`)
	for _, ln := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if m := re.FindStringSubmatch(ln); m != nil {
			return strings.Trim(strings.TrimSpace(m[2]), `"'`)
		}
	}
	return ""
}

func dotenvValue(v string) string {
	if strings.ContainsAny(v, " #\"'$") {
		return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
	}
	return v
}

// ---------- YAML（基于 yaml.v3 节点，保留注释与键顺序） ----------

// LoadYAML 解析 YAML 文档，返回顶层 mapping 节点与整个文档。
func LoadYAML(data []byte) (doc *yaml.Node, root *yaml.Node, err error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	doc = &yaml.Node{}
	if len(bytes.TrimSpace(data)) > 0 {
		if err := yaml.Unmarshal(data, doc); err != nil {
			return nil, nil, err
		}
	}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		doc = &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	root = doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("YAML 顶层不是映射")
	}
	return doc, root, nil
}

// DumpYAML 以两格缩进输出。
func DumpYAML(doc *yaml.Node) ([]byte, error) {
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return b.Bytes(), nil
}

// YGet 在 mapping 里取键对应的值节点。
func YGet(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// YSet 在 mapping 里设置键（已存在则原位替换值，保留键上的注释）。
func YSet(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			// 保留原值节点上的行尾/头部注释。
			val.HeadComment = firstNonEmptyStr(val.HeadComment, m.Content[i+1].HeadComment)
			val.LineComment = firstNonEmptyStr(val.LineComment, m.Content[i+1].LineComment)
			m.Content[i+1] = val
			return
		}
	}
	m.Content = append(m.Content, YStr(key), val)
}

// YDelete 删除 mapping 中的键。
func YDelete(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}

// YMap 取子 mapping，不存在或类型不对时新建。
func YMap(m *yaml.Node, key string) *yaml.Node {
	if v := YGet(m, key); v != nil && v.Kind == yaml.MappingNode {
		return v
	}
	n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	YSet(m, key, n)
	return n
}

// YStr 构造字符串标量。
func YStr(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }

// YInt 构造整数标量。
func YInt(n int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: fmt.Sprint(n)}
}

// YBool 构造布尔标量。
func YBool(b bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: fmt.Sprint(b)}
}

// YFlowList 构造行内字符串列表 [a, b]。
func YFlowList(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
	for _, s := range items {
		n.Content = append(n.Content, YStr(s))
	}
	return n
}

// YMapOf 按顺序构造 mapping：YMapOf("a", YStr("x"), "b", YInt(1))。
func YMapOf(kv ...any) *yaml.Node {
	n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for i := 0; i+1 < len(kv); i += 2 {
		n.Content = append(n.Content, YStr(kv[i].(string)), kv[i+1].(*yaml.Node))
	}
	return n
}

// YScalar 读取标量值。
func YScalar(m *yaml.Node, key string) string {
	if v := YGet(m, key); v != nil && v.Kind == yaml.ScalarNode {
		return v.Value
	}
	return ""
}

func firstNonEmptyStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
