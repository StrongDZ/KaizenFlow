package fmcg

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/kaizenflow/api/internal/store"
)

const ProviderHybridRuntime = "hybrid_runtime"

type BuildRequest struct {
	Graph        *store.Graph
	Types        map[string]store.NodeType
	Levels       map[string]map[string]float64
	Observations map[string]Observation
	Now          time.Time
	HorizonS     float64
}

type BuildResult struct {
	Overrides []map[string]any
	Meta      map[string]any
}

type NowcastProvider interface {
	Name() string
	BuildNowcast(context.Context, BuildRequest) (BuildResult, error)
}

type providerFunc struct {
	name string
	fn   func(context.Context, BuildRequest) (BuildResult, error)
}

func (p providerFunc) Name() string { return p.name }

func (p providerFunc) BuildNowcast(ctx context.Context, req BuildRequest) (BuildResult, error) {
	return p.fn(ctx, req)
}

var providerRegistry = struct {
	sync.RWMutex
	items map[string]NowcastProvider
}{
	items: map[string]NowcastProvider{},
}

func init() {
	RegisterNowcastProvider(providerFunc{
		name: ProviderHybridRuntime,
		fn: func(_ context.Context, req BuildRequest) (BuildResult, error) {
			overrides, meta, err := BuildRuntimeNowcast(req.Graph, req.Types, req.Levels, req.Observations, req.Now, req.HorizonS)
			if err != nil {
				return BuildResult{}, err
			}
			if meta != nil && meta["provider"] == nil {
				meta["provider"] = ProviderHybridRuntime
			}
			return BuildResult{Overrides: overrides, Meta: meta}, nil
		},
	})
}

func RegisterNowcastProvider(p NowcastProvider) {
	if p == nil {
		panic("fmcg: nowcast provider is nil")
	}
	name := p.Name()
	if name == "" {
		panic("fmcg: nowcast provider name is empty")
	}
	providerRegistry.Lock()
	defer providerRegistry.Unlock()
	providerRegistry.items[name] = p
}

func DefaultNowcastProvider() NowcastProvider {
	p, err := ProviderByName(ProviderHybridRuntime)
	if err != nil {
		panic(err)
	}
	return p
}

func ProviderByName(name string) (NowcastProvider, error) {
	providerRegistry.RLock()
	defer providerRegistry.RUnlock()
	p, ok := providerRegistry.items[name]
	if !ok {
		return nil, fmt.Errorf("unknown FMCG nowcast provider %q", name)
	}
	return p, nil
}

func RegisteredProviderNames() []string {
	providerRegistry.RLock()
	defer providerRegistry.RUnlock()
	out := make([]string, 0, len(providerRegistry.items))
	for name := range providerRegistry.items {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
