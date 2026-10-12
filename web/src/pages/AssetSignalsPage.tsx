import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Plug } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Asset, Binding, SignalDef, SourceRow } from '../api/types'
import { Field, FormDialog } from '../components/FormDialog'
import { ItemIdentity, roleColor } from '../components/NodeIdentity'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, SearchBox, Tag, btn, btnDangerOutline, btnPrimary, input } from '../components/ui'
import { leafPaths } from '../lib/livePath'
import { filterRows } from '../lib/table'

type Row = { asset: Asset; signal: SignalDef; binding?: Binding }

/**
 * Tín hiệu thiết bị: ghép mỗi tín hiệu của một thiết bị với một nguồn, MỘT lần cho cả app.
 * Mọi mô hình có thiết bị đó dùng ngay. Tín hiệu của đường nối vẫn ghép trong mô hình
 * (một đường nối chỉ tồn tại trong một bố trí), nên trang này chỉ nhận thiết bị.
 */
export default function AssetSignalsPage() {
  const qc = useQueryClient()
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets })
  const bindings = useQuery({ queryKey: ['asset-bindings'], queryFn: api.assetBindings })
  const [q, setQ] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [edit, setEdit] = useState<Row | null>(null)

  const rows = useMemo<Row[]>(() => {
    const byRef = new Map((bindings.data ?? []).map((b) => [`${b.subject}|${b.signal}`, b]))
    const out: Row[] = []
    for (const a of assets.data ?? []) {
      for (const signal of a.signals ?? []) {
        out.push({ asset: a, signal, binding: byRef.get(`${a.key}|${signal.name}`) })
      }
    }
    return out
  }, [assets.data, bindings.data])

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAssetBinding(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['asset-bindings'] }) },
  })

  if (assets.isLoading || bindings.isLoading) return <Loading />
  const shown = filterRows(rows.filter((r) => !onlyMissing || !r.binding), q, (r) => [r.asset.key, r.asset.name, r.signal.name, r.signal.label])
  const bound = rows.filter((r) => r.binding).length

  const columns: Column<Row>[] = [
    {
      key: 'asset', header: 'Thiết bị',
      cell: (r) => <ItemIdentity icon={Cpu} name={r.asset.name || r.asset.key} code={r.asset.name ? r.asset.key : undefined} color={roleColor(r.asset.archetype)} />,
      sort: (r) => r.asset.name || r.asset.key,
    },
    { key: 'signal', header: 'Tín hiệu', cell: (r) => <span className="flex items-center gap-1.5">{r.signal.label}<Tag>{r.signal.name}</Tag></span>, sort: (r) => r.signal.name },
    {
      key: 'source', header: 'Nguồn',
      cell: (r) => r.binding
        ? <span className="font-mono text-text-2">{r.binding.source}{r.binding.json_path ? <span className="text-faint"> · {r.binding.json_path}</span> : null}</span>
        : <span className="text-faint">chưa ghép</span>,
      sort: (r) => r.binding?.source ?? '',
    },
    {
      key: 'models', header: 'Áp cho', cell: (r) => r.asset.models.length === 0
        ? <span className="text-faint">chưa mô hình nào</span>
        : <span className="text-text-2">{r.asset.models.length} mô hình</span>,
      sort: (r) => r.asset.models.length,
    },
    {
      key: 'act', header: '', align: 'right',
      cell: (r) => (
        <span className="flex justify-end gap-2">
          <button className={btn} onClick={(e) => { e.stopPropagation(); setEdit(r) }}>{r.binding ? 'Sửa' : 'Ghép nguồn'}</button>
          {r.binding && (
            <button className={btnDangerOutline} disabled={remove.isPending}
              onClick={(e) => { e.stopPropagation(); remove.mutate(r.binding!.id) }}>Bỏ ghép</button>
          )}
        </span>
      ),
    },
  ]

  return (
    <PageBody wide>
      <PageHeader icon={Plug}
        title="Tín hiệu thiết bị"
        subtitle={`${bound}/${rows.length} tín hiệu đã có nguồn`}
        actions={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Tìm theo thiết bị hoặc tín hiệu" />
            <button className={onlyMissing ? btnPrimary : btn} onClick={() => setOnlyMissing(!onlyMissing)}>Chỉ cái chưa ghép</button>
          </>
        }
      />
      <Notice>
        Ghép ở đây một lần là xong cho mọi mô hình có thiết bị đó — tín hiệu là thuộc tính của máy, không của mô hình.
        Tín hiệu của <em>đường nối</em> (lượng hàng đã chuyển, thời gian chuyến) vẫn ghép trong trang Kết nối dữ liệu của từng mô hình,
        vì đường nối chỉ tồn tại trong một bố trí. Chưa có thiết bị nào thì khai ở <Link to="/assets" className="text-accent underline">Thiết bị</Link>.
      </Notice>
      <ErrorBox error={assets.error ?? bindings.error ?? remove.error} />
      {edit && <SourceDialog row={edit} onClose={() => setEdit(null)} />}
      <DataTable
        rows={shown} columns={columns} rowKey={(r) => `${r.asset.key}|${r.signal.name}`}
        onRowClick={(r) => setEdit(r)}
        initialSort={{ key: 'asset', dir: 'asc' }}
        empty={<EmptyState title={rows.length === 0 ? 'Chưa có tín hiệu nào để ghép' : 'Không có dòng khớp'}>
          {rows.length === 0
            ? 'Tín hiệu sinh ra từ loại node của thiết bị. Khai thiết bị ở trang Thiết bị trước.'
            : 'Thử từ khoá khác, hoặc tắt "Chỉ cái chưa ghép".'}
        </EmptyState>}
      />
    </PageBody>
  )
}

/** Hộp ghép một tín hiệu thiết bị với một nguồn. Chỉ chế độ "từ nguồn": công thức tự tính cần các
 *  đối tượng quanh nó trong một sơ đồ cụ thể nên vẫn làm ở Kết nối dữ liệu của mô hình. */
function SourceDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient()
  const sources = useQuery({ queryKey: ['all-sources'], queryFn: api.allSources })
  const [source, setSource] = useState(row.binding?.source ?? '')
  const [path, setPath] = useState(row.binding?.json_path ?? '')
  const picked = (sources.data ?? []).find((s) => s.source === source)
  // Trường có thể lấy: các đường dẫn lá trong bản tin mẫu của nguồn đã chọn.
  const fields = picked?.sample ? leafPaths(picked.sample) : []
  const save = useMutation({
    mutationFn: () => api.saveAssetBindings([{
      subject: row.asset.key, signal: row.signal.name, source: source.trim(), json_path: path.trim(), enabled: true, mode: 'source',
    }]),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['asset-bindings'] }); onClose() },
  })
  return (
    <FormDialog
      open title={`${row.asset.name || row.asset.key} · ${row.signal.label}`}
      description={row.asset.models.length
        ? `Lưu xong, ${row.asset.models.join(', ')} đều dùng tín hiệu này.`
        : 'Thiết bị này chưa nằm trong mô hình nào; ghép nối vẫn lưu và sẽ dùng được ngay khi bạn đặt nó lên một sơ đồ.'}
      submitLabel="Lưu" pending={save.isPending} error={save.error}
      canSubmit={source.trim() !== ''} onSubmit={() => save.mutate()} onClose={onClose}
    >
      <Field
        label="Nguồn"
        hint={picked
          ? `${picked.desc || 'chưa có mô tả'} · ${picked.count.toLocaleString('vi-VN')} bản tin${picked.models.length ? ` · đang dùng ở ${picked.models.join(', ')}` : ''}`
          : 'Chọn thiết bị/topic trong danh mục, hoặc gõ tên nguồn (hỗ trợ ký tự thay thế + và #).'}
      >
        <input autoFocus className={`${input} w-full font-mono`} value={source} list="asset-sources"
          placeholder="plc/prs-02/status" onChange={(e) => setSource(e.target.value)} />
        <datalist id="asset-sources">
          {(sources.data ?? []).map((s: SourceRow) => <option key={s.source} value={s.source} label={s.desc || undefined} />)}
        </datalist>
      </Field>
      <Field
        label="Đường dẫn trong bản tin"
        hint={fields.length ? 'Chọn trường trong bản tin mẫu của nguồn, hoặc gõ đường dẫn khác.' : 'Trường cần lấy, vd. st hoặc data.level. Để trống nếu bản tin chỉ là một giá trị.'}
      >
        <input className={`${input} w-full font-mono`} value={path} list="asset-fields" placeholder="st" onChange={(e) => setPath(e.target.value)} />
        <datalist id="asset-fields">{fields.map((f) => <option key={f.path} value={f.path} label={String(f.value)} />)}</datalist>
      </Field>
    </FormDialog>
  )
}
