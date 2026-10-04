package fmcg

import (
	"context"
	"testing"
)

type testProvider struct{ name string }

func (p testProvider) Name() string { return p.name }

func (p testProvider) BuildNowcast(context.Context, BuildRequest) (BuildResult, error) {
	return BuildResult{Meta: map[string]any{"provider": p.name}}, nil
}

func TestProviderByNameReturnsRegisteredProvider(t *testing.T) {
	const name = "test_provider_registry"
	RegisterNowcastProvider(testProvider{name: name})
	p, err := ProviderByName(name)
	if err != nil {
		t.Fatalf("ProviderByName() error = %v", err)
	}
	if p.Name() != name {
		t.Fatalf("provider name = %q, want %q", p.Name(), name)
	}
}
