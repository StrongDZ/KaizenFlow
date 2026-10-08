package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// ErrCameraNotFound is returned for an unknown camera.
var ErrCameraNotFound = errors.New("camera not found")

// Camera is an entry of the camera registry. A camera belongs to no machine:
// the gauges of any machine refer to it by ID.
type Camera struct {
	CameraID  string    `json:"camera_id"`
	Name      string    `json:"name"`
	Location  string    `json:"location"`
	URL       string    `json:"url"`
	SampleFPS uint32    `json:"sample_fps"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CameraStore persists the camera registry.
type CameraStore interface {
	PutCamera(ctx context.Context, c Camera) (Camera, error)
	GetCamera(ctx context.Context, id string) (Camera, error)
	ListCameras(ctx context.Context) ([]Camera, error)
	DeleteCamera(ctx context.Context, id string) error
}

// PgCameraStore is the PostgreSQL implementation.
type PgCameraStore struct{ pool *pgxpool.Pool }

func NewPgCameraStore(pool *pgxpool.Pool) *PgCameraStore { return &PgCameraStore{pool: pool} }

const cameraColumns = `camera_id, name, location, url, sample_fps, updated_at`

func scanCamera(row pgx.Row) (Camera, error) {
	var c Camera
	err := row.Scan(&c.CameraID, &c.Name, &c.Location, &c.URL, &c.SampleFPS, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, ErrCameraNotFound
	}
	return c, err
}

func (p *PgCameraStore) PutCamera(ctx context.Context, c Camera) (Camera, error) {
	return scanCamera(p.pool.QueryRow(ctx, `
		INSERT INTO camera (camera_id, name, location, url, sample_fps) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (camera_id) DO UPDATE SET
		  name = EXCLUDED.name, location = EXCLUDED.location, url = EXCLUDED.url,
		  sample_fps = EXCLUDED.sample_fps, updated_at = now()
		RETURNING `+cameraColumns, c.CameraID, c.Name, c.Location, c.URL, c.SampleFPS))
}

func (p *PgCameraStore) GetCamera(ctx context.Context, id string) (Camera, error) {
	return scanCamera(p.pool.QueryRow(ctx, `SELECT `+cameraColumns+` FROM camera WHERE camera_id = $1`, id))
}

func (p *PgCameraStore) ListCameras(ctx context.Context) ([]Camera, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+cameraColumns+` FROM camera ORDER BY camera_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Camera
	for rows.Next() {
		c, err := scanCamera(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PgCameraStore) DeleteCamera(ctx context.Context, id string) error {
	tag, err := p.pool.Exec(ctx, `DELETE FROM camera WHERE camera_id = $1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrCameraNotFound
	}
	return err
}

// resolveCameras makes a station config self-contained: for every gauge on a
// camera of the registry, the camera is copied into cfg.cameras with the url
// and rate the registry holds. Cameras no gauge refers to are dropped. A
// camera_id the registry does not know is left to Validate, which accepts it
// only when the config defines that camera itself.
func resolveCameras(ctx context.Context, cameras CameraStore, cfg *gaugev1.StationConfig) error {
	used := map[string]bool{}
	for _, g := range cfg.GetGauges() {
		if id := g.GetCameraId(); id != "" && id != cfg.GetCamera().GetCameraId() {
			used[id] = true
		}
	}
	kept := make([]*gaugev1.Camera, 0, len(used))
	inline := map[string]*gaugev1.Camera{}
	for _, c := range cfg.GetCameras() {
		inline[c.GetCameraId()] = c
	}
	// The order of the gauges, so that the same config always resolves to the same bytes.
	for _, g := range cfg.GetGauges() {
		id := g.GetCameraId()
		if !used[id] {
			continue
		}
		used[id] = false
		reg, err := cameras.GetCamera(ctx, id)
		switch {
		case err == nil:
			kept = append(kept, &gaugev1.Camera{CameraId: id, Url: reg.URL, SampleFps: reg.SampleFPS})
		case !errors.Is(err, ErrCameraNotFound):
			return err
		case inline[id] != nil:
			kept = append(kept, inline[id])
		}
	}
	cfg.Cameras = kept
	return nil
}

// Cameras is the REST interface of the camera registry.
type Cameras struct {
	cameras   CameraStore
	stations  Store
	publisher *Publisher
	api       *API
}

func NewCameras(cameras CameraStore, stations Store, publisher *Publisher, api *API) *Cameras {
	return &Cameras{cameras: cameras, stations: stations, publisher: publisher, api: api}
}

func (c *Cameras) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cameras", c.api.wrap(c.list))
	mux.HandleFunc("PUT /v1/cameras/{camera_id}", c.api.wrap(c.put))
	mux.HandleFunc("DELETE /v1/cameras/{camera_id}", c.api.wrap(c.delete))
}

// cameraUse says how many gauges of a machine are on a camera.
type cameraUse struct {
	MachineID string `json:"machine_id"`
	Gauges    int    `json:"gauges"`
}

type cameraView struct {
	Camera
	// Machines with a gauge on this camera: one camera can serve several.
	Machines []cameraUse `json:"machines"`
}

// usage maps camera_id -> the machines whose gauges are on it.
func (c *Cameras) usage(ctx context.Context) (map[string][]cameraUse, []Stored, error) {
	stations, err := c.stations.List(ctx)
	if err != nil {
		return nil, nil, err
	}
	out := map[string][]cameraUse{}
	for _, s := range stations {
		cfg, err := ParseConfig(s.Config)
		if err != nil {
			continue // a stored config this version cannot read uses no registry camera
		}
		count := map[string]int{}
		for _, g := range cfg.GetGauges() {
			if id := g.GetCameraId(); id != "" {
				count[id]++
			}
		}
		for id, n := range count {
			out[id] = append(out[id], cameraUse{MachineID: s.MachineID, Gauges: n})
		}
	}
	return out, stations, nil
}

func (c *Cameras) fail(w http.ResponseWriter, err error) int {
	if errors.Is(err, ErrCameraNotFound) {
		return writeJSON(w, http.StatusNotFound, apiError{Error: "camera not found"})
	}
	return c.api.fail(w, err)
}

func (c *Cameras) list(w http.ResponseWriter, r *http.Request) int {
	cameras, err := c.cameras.ListCameras(r.Context())
	if err != nil {
		return c.fail(w, err)
	}
	usage, _, err := c.usage(r.Context())
	if err != nil {
		return c.fail(w, err)
	}
	out := make([]cameraView, len(cameras))
	for i, cam := range cameras {
		out[i] = cameraView{Camera: cam, Machines: usage[cam.CameraID]}
		if out[i].Machines == nil {
			out[i].Machines = []cameraUse{}
		}
	}
	return writeJSON(w, http.StatusOK, map[string]any{"cameras": out})
}

// put creates or changes a camera. The stations with a gauge on it get a new
// config version carrying the new url or rate, published like any other.
func (c *Cameras) put(w http.ResponseWriter, r *http.Request) int {
	var cam Camera
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err == nil {
		err = json.Unmarshal(body, &cam)
	}
	if err != nil {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid JSON body: " + err.Error()})
	}
	cam.CameraID = r.PathValue("camera_id")
	var problems []string
	if !identifier.MatchString(cam.CameraID) {
		problems = append(problems, "camera_id must be 1-64 characters of A-Z a-z 0-9 _ . -")
	}
	if cam.URL == "" {
		problems = append(problems, "url is required")
	}
	if cam.SampleFPS < 1 || cam.SampleFPS > 30 {
		problems = append(problems, "sample_fps must be between 1 and 30")
	}
	if len(cam.Name) > 120 || len(cam.Location) > 200 {
		problems = append(problems, "name is at most 120 characters and location 200")
	}
	if len(problems) > 0 {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid camera", Details: problems})
	}
	stored, err := c.cameras.PutCamera(r.Context(), cam)
	if err != nil {
		return c.fail(w, err)
	}
	usage, stations, err := c.usage(r.Context())
	if err != nil {
		return c.fail(w, err)
	}
	using := map[string]bool{}
	for _, u := range usage[cam.CameraID] {
		using[u.MachineID] = true
	}
	for _, s := range stations {
		if !using[s.MachineID] {
			continue
		}
		if err := c.refresh(r.Context(), s); err != nil {
			return c.fail(w, err)
		}
	}
	c.publisher.Wake()
	view := cameraView{Camera: stored, Machines: usage[cam.CameraID]}
	if view.Machines == nil {
		view.Machines = []cameraUse{}
	}
	return writeJSON(w, http.StatusOK, view)
}

// refresh stores a new version of a station config when resolving its
// cameras again changes it.
func (c *Cameras) refresh(ctx context.Context, s Stored) error {
	cfg, err := ParseConfig(s.Config)
	if err != nil {
		return nil
	}
	before := proto.Clone(cfg).(*gaugev1.StationConfig)
	if err := resolveCameras(ctx, c.cameras, cfg); err != nil {
		return err
	}
	if proto.Equal(before, cfg) || len(Validate(cfg)) > 0 {
		return nil
	}
	cfg.ConfigVersion = 0
	canonical, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(cfg)
	if err != nil {
		return err
	}
	_, err = c.stations.Put(ctx, s.MachineID, cfg.GetPlant(), cfg.GetLine(), canonical)
	return err
}

// delete refuses to remove a camera a gauge is still on.
func (c *Cameras) delete(w http.ResponseWriter, r *http.Request) int {
	id := r.PathValue("camera_id")
	usage, _, err := c.usage(r.Context())
	if err != nil {
		return c.fail(w, err)
	}
	if len(usage[id]) > 0 {
		return writeJSON(w, http.StatusConflict, apiError{Error: "camera is in use: move or remove its gauges first"})
	}
	if err := c.cameras.DeleteCamera(r.Context(), id); err != nil {
		return c.fail(w, err)
	}
	w.WriteHeader(http.StatusNoContent)
	return http.StatusNoContent
}
