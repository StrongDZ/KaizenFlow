import { useQuery } from '@tanstack/react-query'
import { gaugeApi, type GaugeReading } from '../../api/gauge'
import { roiCrop } from '../../lib/gaugeView'
import { devicePhoto } from './devicePhotos'

/** Ảnh nhỏ chấp nhận khung hình cũ tới 10 phút: server trả ngay khung nó còn giữ thay vì mở lại camera. */
const STILL_MAX_AGE_S = 600

/** Một khung hình của camera, lấy một lần khi mở trang: đủ để thấy đúng thiết bị ở trạm, không cần chạy theo thời gian thực.
    Mọi đồng hồ trên cùng một camera dùng chung một lần lấy. */
function useStill(machine: string, camera: string) {
  return useQuery({
    queryKey: ['gauge', 'still', machine, camera],
    queryFn: () => gaugeApi.frame(machine, camera, STILL_MAX_AGE_S),
    staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: 1,
  })
}

/** Ảnh của một đồng hồ: vùng đọc của nó cắt ra từ khung hình camera. Lấp đầy phần tử cha (cần `relative`), `aspect` là tỉ lệ rộng / cao của phần tử đó.
    Khi chưa lấy được khung hình thì hiện ảnh minh hoạ của loại thiết bị. */
export function RoiPhoto({ machine, gauge, aspect, dimmed = false }: { machine: string; gauge: GaugeReading; aspect: number; dimmed?: boolean }) {
  const still = useStill(machine, gauge.camera_id)
  const crop = still.data ? roiCrop(gauge.roi, still.data.width, still.data.height, aspect) : null
  const fade = dimmed ? 'opacity-40 grayscale' : ''
  if (still.data && crop) {
    return (
      <div className={`absolute inset-0 flex items-center justify-center bg-black ${fade}`} title="Ảnh từ camera của trạm">
        <div className="relative overflow-hidden" style={{ width: `${crop.window.width}%`, height: `${crop.window.height}%` }}>
          <img
            src={`data:image/jpeg;base64,${still.data.frame_jpeg}`} alt={`${gauge.gauge_id} trên camera`}
            className="absolute max-w-none"
            style={{ width: `${crop.image.width}%`, height: `${crop.image.height}%`, left: `${crop.image.left}%`, top: `${crop.image.top}%` }}
          />
        </div>
      </div>
    )
  }
  const photo = devicePhoto(gauge.type)
  if (still.isPending) return <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-faint">đang lấy ảnh…</span>
  if (!photo) return null
  return <img src={photo.src} alt={photo.kind} title={`Ảnh minh hoạ: ${photo.kind}`} loading="lazy" className={`absolute inset-0 h-full w-full object-cover ${fade}`} />
}
