import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck } from 'lucide-react'
import { AlertKindIcon } from '../AlertKind'
import { api } from '../../api/client'
import { describeDrift } from '../../lib/insights'
import { fmtFactoryTime } from '../../lib/liveFormat'
import { ErrorBox, btn, btnAccentOutline } from '../ui'

/**
 * Cảnh báo lệch dự báo: tồn kho thật ra ngoài dải của dự báo gần nhất trong nhiều lần kiểm liên tiếp. Nghĩa là mô hình
 * (hoặc dữ kiện đầu vào của nó) đang không còn khớp thực tế, nên dự báo cũ không đáng tin nữa: dự báo lại từ trạng thái hiện tại.
 */
export function DriftAlerts({ model, names, horizonS = 86400 }: { model: string; names: Record<string, string>; horizonS?: number }) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['insights', 'drift', model],
    queryFn: () => api.insights({ kind: 'DRIFT', status: 'OPEN', limit: 50 }),
    refetchInterval: 5000,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['insights'] })
    void qc.invalidateQueries({ queryKey: ['runs', 'nowcast', model] })
  }
  const ack = useMutation({ mutationFn: (id: number) => api.ackInsight(id), onSuccess: refresh })
  const recast = useMutation({
    mutationFn: async (id: number) => {
      await api.liveForecast(model, horizonS)
      await api.ackInsight(id)
    },
    onSuccess: refresh,
  })
  const mine = (list.data ?? []).filter((i) => i.model_key === model)
  return (
    <div className="space-y-2 text-xs">
      {mine.length === 0 ? (
        <div className="flex items-center gap-2.5 text-[11px] text-muted" title="Cảnh báo hiện ra khi tồn kho thật đi ra ngoài dải của dự báo gần nhất nhiều lần liên tiếp, tức thực tế đã khác mô hình.">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-ok/12 text-ok" aria-hidden><CircleCheck size={14} /></span>
          Thực tế vẫn nằm trong dải dự báo.
        </div>
      ) : mine.map((i) => (
        <div key={i.id} className="space-y-1.5 rounded-lg bg-accent/8 p-2">
          <div className="flex gap-2">
            <AlertKindIcon kind="DRIFT" size={26} />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] font-medium leading-snug text-text">{describeDrift(i, (k) => names[k] ?? k)}</div>
              <div className="text-[10.5px] text-muted">lúc {fmtFactoryTime(typeof i.payload.at === 'string' ? i.payload.at : i.created_at)}</div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button className={btnAccentOutline} disabled={recast.isPending} onClick={() => recast.mutate(i.id)}>Dự báo lại từ bây giờ</button>
            <button className={btn} disabled={ack.isPending} onClick={() => ack.mutate(i.id)}>Đã xem</button>
          </div>
        </div>
      ))}
      <ErrorBox error={list.error ?? ack.error ?? recast.error} />
    </div>
  )
}
