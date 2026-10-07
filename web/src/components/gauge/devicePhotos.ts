/** Ảnh minh hoạ theo loại đồng hồ (config.proto: type). Là ảnh của loại thiết bị, không phải thiết bị trong nhà máy;
    nguồn và giấy phép từng ảnh ở public/gauge/CREDITS.md và được ghi lại ngay trên trang. */
export type DevicePhoto = { src: string; kind: string; page: string; author: string; license: string }

const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`

const PHOTOS: Record<string, DevicePhoto> = {
  analog_dial: { src: '/gauge/analog_dial.jpg', kind: 'Đồng hồ kim', page: commons('Manometer_104026.jpg'), author: 'Nord68', license: 'CC BY-SA 4.0' },
  seg7: { src: '/gauge/seg7.jpg', kind: 'Đồng hồ số LED', page: commons('DIGEM_ff1B.jpg'), author: 'Mister rf', license: 'CC BY-SA 4.0' },
  rolling_counter: { src: '/gauge/rolling_counter.jpg', kind: 'Bộ đếm giờ', page: commons('Stundenzaehler.jpg'), author: 'Ulfbastel', license: 'phạm vi công cộng' },
  timer_mmss: { src: '/gauge/timer_mmss.jpg', kind: 'Màn hình thời gian', page: commons('Digital-clock-alarm.jpg'), author: 'Tysto', license: 'phạm vi công cộng' },
}

export function devicePhoto(type: string): DevicePhoto | undefined {
  return PHOTOS[type]
}

export const DEVICE_PHOTOS: DevicePhoto[] = Object.values(PHOTOS)
