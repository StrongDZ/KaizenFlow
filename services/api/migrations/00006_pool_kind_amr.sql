-- +goose Up
-- Loại xe AMR (tự hành, FMS điều phối) cùng với AGV (băng từ): thêm vào danh sách `kind` trong schema tham số đã lưu của các loại node
-- RESOURCE_POOL. Loại node chỉ được nạp lần đầu nên DB đã có từ trước không tự nhận giá trị mới.
UPDATE node_type
SET param_schema = jsonb_set(param_schema, '{properties,kind,enum}', '["AGV","AMR","TUGGER","FORKLIFT","OPERATOR"]'::jsonb)
WHERE archetype = 'RESOURCE_POOL' AND param_schema #> '{properties,kind,enum}' IS NOT NULL;

-- +goose Down
UPDATE node_type
SET param_schema = jsonb_set(param_schema, '{properties,kind,enum}', '["AGV","TUGGER","FORKLIFT","OPERATOR"]'::jsonb)
WHERE archetype = 'RESOURCE_POOL' AND param_schema #> '{properties,kind,enum}' IS NOT NULL;
