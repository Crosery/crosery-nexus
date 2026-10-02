package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp/syntax"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/redact"
	"github.com/yetone/magpie/internal/settings"
	"github.com/yetone/magpie/internal/stats"
)

// The gateway-effective part of Magpie's settings.json (the same file and
// the same settings.Save the desktop app uses). Only these keys are read or
// written here; lanKey, proxy, warm-ups and the desktop's own keys are never
// returned or changed. The gateway reads the file on every request, so a
// write applies from the next request, no restart.
var settingsKeys = []string{"redact", "redactPersonal", "redactWords", "redactRules", "vision", "imageGen"}

const (
	maxRedactWords  = 100
	minWordBytes    = 2 // Magpie ignores shorter words (redact.Mask)
	maxWordBytes    = 64
	maxModelID      = 200
	maxRegexInst    = 2000 // compiled RE2 program size; RE2 is linear time, this caps the constant
	maxSettingsBody = 64 << 10
	maxListedModels = 500
)

var settingsMu sync.Mutex

type modelRef struct {
	ID           string `json:"id"`
	Name         string `json:"name,omitempty"`
	Provider     string `json:"provider,omitempty"`
	ProviderName string `json:"providerName,omitempty"`
}

type telemetryView struct {
	Off    bool   `json:"off"`
	Forced bool   `json:"forced"`
	Sender bool   `json:"sender"`
	Reason string `json:"reason"`
}

type settingsView struct {
	Redact            bool          `json:"redact"`
	RedactPersonal    bool          `json:"redactPersonal"`
	RedactWords       []string      `json:"redactWords"`
	RedactRules       []redact.Rule `json:"redactRules"`
	Vision            string        `json:"vision"`
	ImageGen          string        `json:"imageGen"`
	VisionAuto        string        `json:"visionAuto"`
	ImageGenAuto      string        `json:"imageGenAuto"`
	VisionEffective   string        `json:"visionEffective"`
	ImageGenEffective string        `json:"imageGenEffective"`
	VisionModels      []modelRef    `json:"visionModels"`
	ImageGenModels    []modelRef    `json:"imageGenModels"`
	Models            []modelRef    `json:"models"`
	Telemetry         telemetryView `json:"telemetry"`
	Applies           string        `json:"applies"`
	Keys              []string      `json:"keys"`
}

// effective is what the gateway uses for a model setting: off, the named
// model while it resolves, else the automatic pick (gateway.seer/drawer).
func effective(v, auto string) string {
	switch v {
	case "off":
		return ""
	case "":
		return auto
	}
	if _, _, ok := provider.Resolve(v); ok {
		return v
	}
	return auto
}

func telemetry() telemetryView {
	forced := false
	for _, k := range []string{"DO_NOT_TRACK", "MAGPIE_NO_STATS"} {
		if v := os.Getenv(k); v != "" && v != "0" && v != "false" {
			forced = true
		}
	}
	reason := "the kernel never starts the stats sender"
	if forced {
		reason = "forced off by the launcher environment; the kernel never starts the stats sender"
	}
	return telemetryView{Off: stats.Off(), Forced: true, Sender: false, Reason: reason}
}

func currentSettings() settingsView {
	s := settings.Load()
	v := settingsView{
		Redact: s.Redact, RedactPersonal: s.RedactPersonal,
		RedactWords: nonNil(s.RedactWords), RedactRules: nonNil(s.RedactRules),
		Vision: s.Vision, ImageGen: s.ImageGen,
		VisionAuto: gateway.AutoVision(), ImageGenAuto: gateway.AutoDrawer(),
		VisionModels: []modelRef{}, ImageGenModels: []modelRef{}, Models: []modelRef{},
		Telemetry: telemetry(), Applies: "next-request", Keys: settingsKeys,
	}
	v.VisionEffective, v.ImageGenEffective = effective(s.Vision, v.VisionAuto), effective(s.ImageGen, v.ImageGenAuto)
	// the same candidates the desktop's Settings offers (gui/api.go settingsState)
	for _, e := range provider.Served() {
		if e.Images && (e.ImageInput == nil || *e.ImageInput) && (e.Group != "" || e.Provider.Ready()) && len(v.VisionModels) < maxListedModels {
			m := modelRef{ID: e.ID, Name: e.Name, Provider: e.Provider.ID, ProviderName: e.Provider.Name}
			if e.Group != "" {
				m.Provider, m.ProviderName = "", e.Group
			}
			v.VisionModels = append(v.VisionModels, m)
		}
	}
	for _, p := range provider.All() {
		if !p.On() || p.Decides() {
			continue
		}
		for _, m := range gateway.Drawers(p) {
			if len(v.ImageGenModels) < maxListedModels {
				v.ImageGenModels = append(v.ImageGenModels, modelRef{ID: p.ID + "/" + m.ID, Name: m.Name, Provider: p.ID, ProviderName: p.Name})
			}
		}
		for _, m := range p.Models {
			if len(v.Models) < maxListedModels {
				v.Models = append(v.Models, modelRef{ID: p.ID + "/" + m, Name: m, Provider: p.ID, ProviderName: p.Name})
			}
		}
	}
	return v
}

type settingsError struct{ code, msg string }

func (e settingsError) Error() string { return e.msg }

func invalid(format string, args ...any) error {
	return settingsError{"invalid_setting", fmt.Sprintf(format, args...)}
}

func strictDecode(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing data")
	}
	return nil
}

func cleanWords(in []string) ([]string, error) {
	out := []string{}
	for _, w := range in {
		w = strings.TrimSpace(w)
		if w == "" || slices.Contains(out, w) {
			continue
		}
		if !utf8.ValidString(w) || strings.IndexFunc(w, unicode.IsControl) >= 0 {
			return nil, invalid("a masked word has a control character")
		}
		if len(w) < minWordBytes || len(w) > maxWordBytes {
			return nil, invalid("each masked word is %d to %d bytes, not %q", minWordBytes, maxWordBytes, w)
		}
		out = append(out, w)
	}
	if len(out) > maxRedactWords {
		return nil, invalid("at most %d masked words, not %d", maxRedactWords, len(out))
	}
	return out, nil
}

// checkRegexCost refuses a pattern whose compiled program is large (a{1000}{1000}-like
// nesting): RE2 already rejects backreferences, lookaround and repeats over 1000.
func checkRegexCost(rules []redact.Rule) error {
	for _, r := range rules {
		if r.Regex == "" {
			continue
		}
		re, err := syntax.Parse(r.Regex, syntax.Perl)
		if err != nil {
			continue // redact.CheckRules says why, in Magpie's words
		}
		prog, err := syntax.Compile(re.Simplify())
		if err == nil && len(prog.Inst) > maxRegexInst {
			return invalid("the masking rule %s has a regular expression that is too complex", redact.RuleKind(r.Kind))
		}
	}
	return nil
}

func modelSetting(raw json.RawMessage, cur, what string) (string, error) {
	var v string
	if err := strictDecode(raw, &v); err != nil {
		return "", invalid("%s must be a string", what)
	}
	v = strings.TrimSpace(v)
	if v == "" || v == "off" || v == cur {
		return v, nil
	}
	if len(v) > maxModelID || !strings.Contains(v, "/") {
		return "", invalid("%s must be a model's id such as provider/model, or off", what)
	}
	if _, _, ok := provider.Resolve(v); !ok {
		return "", invalid("no model %s for %s", v, what)
	}
	return v, nil
}

// applySettings merges a partial update of the whitelisted keys into s.
func applySettings(s *settings.Settings, in map[string]json.RawMessage) error {
	for key := range in {
		if !slices.Contains(settingsKeys, key) {
			return settingsError{"unknown_setting", fmt.Sprintf("%s is not a setting the console may change (allowed: %s)", key, strings.Join(settingsKeys, ", "))}
		}
	}
	for _, key := range settingsKeys {
		raw, ok := in[key]
		if !ok {
			continue
		}
		var err error
		switch key {
		case "redact", "redactPersonal":
			var b bool
			if strictDecode(raw, &b) != nil {
				return invalid("%s must be true or false", key)
			}
			if key == "redact" {
				s.Redact = b
			} else {
				s.RedactPersonal = b
			}
		case "redactWords":
			var words []string
			if strictDecode(raw, &words) != nil {
				return invalid("redactWords must be a list of words")
			}
			if s.RedactWords, err = cleanWords(words); err != nil {
				return err
			}
		case "redactRules":
			var rules []redact.Rule
			if strictDecode(raw, &rules) != nil {
				return invalid("redactRules must be a list of {kind, prefix} or {kind, regex}")
			}
			if len(rules) > redact.MaxRules {
				return invalid("at most %d masking rules, not %d", redact.MaxRules, len(rules))
			}
			if err = checkRegexCost(rules); err != nil {
				return err
			}
			if s.RedactRules, err = redact.CheckRules(rules); err != nil {
				return invalid("%s", err.Error())
			}
		case "vision":
			if s.Vision, err = modelSetting(raw, s.Vision, "the vision model"); err != nil {
				return err
			}
		case "imageGen":
			if s.ImageGen, err = modelSetting(raw, s.ImageGen, "the image generation model"); err != nil {
				return err
			}
		}
	}
	return nil
}

func (k *kernel) getSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, currentSettings())
}

func (k *kernel) setSettings(w http.ResponseWriter, r *http.Request) {
	var in map[string]json.RawMessage
	if !decode(w, r, maxSettingsBody, &in) {
		return
	}
	if len(in) == 0 {
		fail(w, 400, "invalid_setting", "no setting to change")
		return
	}
	settingsMu.Lock()
	defer settingsMu.Unlock()
	s := settings.Load()
	if err := applySettings(&s, in); err != nil {
		code := "invalid_setting"
		if se, ok := err.(settingsError); ok {
			code = se.code
		}
		fail(w, 400, code, err.Error())
		return
	}
	// stats are never sent from the kernel; a hand edit cannot turn them back on either
	s.NoStats = true
	if err := settings.Save(s); err != nil {
		fail(w, 400, "invalid_setting", err.Error())
		return
	}
	writeJSON(w, 200, currentSettings())
}
