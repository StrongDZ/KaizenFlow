# Demo ba nhà máy qua luồng RTSP giả

Ba nhà máy, 21 máy, 20 camera giả (mỗi camera một luồng RTSP), mỗi camera nhìn 2–8 thiết bị đo. Edge đọc các luồng
này như đọc camera thật, nhận dạng tại chỗ và chỉ gửi số về server.

| Nhà máy / dây chuyền | Máy | Đặc điểm |
|---|---|---|
| `NHA_MAY_1 / XUONG_A` | 11 | mỗi máy một camera; `DAY_CHUYEN_SON_11` có 8 thiết bị trên một camera |
| `NHA_MAY_2 / XUONG_THUC_PHAM` | 5 | một camera nhìn hai máy (`BOM_NUOC_24`, `BOM_NUOC_25`) |
| `NHA_MAY_3 / XUONG_CO_KHI` | 5 | một máy cần hai camera (`LO_NHIET_LUYEN_32`); một camera nhìn hai máy (`MAY_HAN_34`, `MAY_CAT_PLASMA_35`) |

## Chạy demo

Từ thư mục gốc của repo, sau `make up`:

```sh
sh infra/compose/sim/demo-factory.sh
```

Lệnh này phát 20 luồng, bật server và edge, rồi khai báo camera và máy qua config-api. Chờ khoảng 1 phút là có số.

Thêm `PRUNE=1` trước lệnh để xoá mọi trạm và camera khác (dữ liệu test tải, demo cũ) khỏi danh sách; số liệu cũ của
chúng vẫn nằm trong lịch sử.

Trên máy có cổng 8090/8092 đã bị ứng dụng khác chiếm thì đổi cổng trước khi chạy:

```sh
CONFIG_API_PORT=8094 CONFIG_API_PORT_2=8095 QUERY_API_PORT=8097 EDGE_AGENT_HTTP_PORT=8096 \
  sh infra/compose/sim/demo-factory.sh
```

Giao diện (repo KaizenFlow, thư mục `web`):

```sh
VITE_GAUGE_API_URL=http://localhost:8097 VITE_GAUGE_CONFIG_API_URL=http://localhost:8094 npx vite --port 5173
```

rồi mở <http://localhost:5173/gauge-twin> và chọn nhà máy ở ô *Dây chuyền*.

## Các luồng RTSP

Link dưới đây mở được trên chính máy chạy demo. Từ máy khác hoặc điện thoại cùng mạng, thay `localhost` bằng
địa chỉ IP của máy chạy demo (xem bằng `ipconfig getifaddr en0`). Bên trong Docker, edge dùng
`rtsp://mediamtx:8554/<tên>`.

### NHA_MAY_1 / XUONG_A

| Máy | Luồng RTSP | Khung hình | Thiết bị trên camera |
|---|---|---|---|
| `TRAM_BOM_01` | `rtsp://localhost:8554/tram_bom_01` | 1280×1280 | áp suất hút, áp suất đẩy, nhiệt độ dầu, tốc độ động cơ (LED) |
| `MAY_NEN_KHI_02` | `rtsp://localhost:8554/may_nen_khi_02` | 1280×1280 | áp suất dầu, nhiệt độ khí nén, bộ đếm giờ chạy, công tơ điện |
| `MAY_EP_03` | `rtsp://localhost:8554/may_ep_03` | 1280×1280 | áp suất thuỷ lực, áp suất khí, tốc độ trục chính (LED), áp suất làm mát |
| `MAY_PHAT_DIEN_04` | `rtsp://localhost:8554/may_phat_dien_04` | 1280×1280 | áp suất dầu bôi trơn, nhiệt độ nước làm mát, bộ đếm giờ chạy, điện năng phát |
| `LO_HOI_05` | `rtsp://localhost:8554/lo_hoi_05` | 1920×640 | áp suất hơi, áp suất nước cấp, nhiệt độ nước cấp |
| `BOM_CHAN_KHONG_06` | `rtsp://localhost:8554/bom_chan_khong_06` | 1280×640 | áp suất chân không, bộ đếm giờ chạy |
| `MAY_LANH_07` | `rtsp://localhost:8554/may_lanh_07` | 1280×1280 | áp suất gas hút, áp suất gas đẩy, nhiệt độ nước ra, công tơ điện |
| `MAY_DONG_GOI_08` | `rtsp://localhost:8554/may_dong_goi_08` | 1920×640 | áp suất khí nén, bộ đếm sản lượng, công tơ điện |
| `TRAM_KHI_NEN_09` | `rtsp://localhost:8554/tram_khi_nen_09` | 1280×1280 | áp suất bình chứa, áp suất đường ống, bộ đếm giờ chạy, công tơ điện |
| `MAY_NGHIEN_10` | `rtsp://localhost:8554/may_nghien_10` | 1920×640 | áp suất thuỷ lực, bộ đếm giờ chạy, bộ đếm sản lượng |
| `DAY_CHUYEN_SON_11` | `rtsp://localhost:8554/day_chuyen_son_11` | 2560×1280 | 8 thiết bị: áp suất sơn, áp suất khí phun, áp suất hút bụi, nhiệt độ lò sấy, nhiệt độ buồng sơn, bộ đếm giờ chạy, bộ đếm sản lượng, công tơ điện |

### NHA_MAY_2 / XUONG_THUC_PHAM

| Camera | Luồng RTSP | Máy | Thiết bị trên camera |
|---|---|---|---|
| Nồi hấp tiệt trùng 21 | `rtsp://localhost:8554/noi_hap_21` | `NOI_HAP_21` | áp suất hơi, nhiệt độ tiệt trùng, bộ đếm giờ chạy |
| Máy chiết rót 22 | `rtsp://localhost:8554/may_chiet_22` | `MAY_CHIET_22` | áp suất khí nén, bộ đếm sản lượng, công tơ điện, áp suất chiết |
| Kho lạnh 23 | `rtsp://localhost:8554/kho_lanh_23` | `KHO_LANH_23` | áp suất gas hút, nhiệt độ giàn ngưng |
| Tường đồng hồ trạm bơm nước | `rtsp://localhost:8554/tram_bom_nuoc` | `BOM_NUOC_24`, `BOM_NUOC_25` | mỗi bơm: áp suất đẩy, công tơ điện |

### NHA_MAY_3 / XUONG_CO_KHI

| Camera | Luồng RTSP | Máy | Thiết bị trên camera |
|---|---|---|---|
| Máy CNC 31 | `rtsp://localhost:8554/may_cnc_31` | `MAY_CNC_31` | áp suất dầu thuỷ lực, nhiệt độ trục chính, bộ đếm sản lượng |
| Lò nhiệt luyện 32, đầu nạp | `rtsp://localhost:8554/lo_nhiet_luyen_dau` | `LO_NHIET_LUYEN_32` | nhiệt độ vùng nạp, áp suất khí bảo vệ |
| Lò nhiệt luyện 32, đầu ra | `rtsp://localhost:8554/lo_nhiet_luyen_cuoi` | `LO_NHIET_LUYEN_32` | nhiệt độ vùng ra, bộ đếm giờ chạy, công tơ điện |
| Máy nén khí 33 | `rtsp://localhost:8554/may_nen_khi_33` | `MAY_NEN_KHI_33` | áp suất bình, áp suất dầu, bộ đếm giờ chạy, công tơ điện |
| Khu hàn và cắt plasma | `rtsp://localhost:8554/han_cat` | `MAY_HAN_34`, `MAY_CAT_PLASMA_35` | hàn: áp suất khí bảo vệ, bộ đếm giờ; cắt: áp suất khí cắt, số lần cắt |

Mọi luồng là H.264, 10 khung hình/giây, lặp lại sau 210 giây.

## Xem một luồng

- **ffplay** (đi kèm ffmpeg, `brew install ffmpeg`):

  ```sh
  ffplay -rtsp_transport tcp rtsp://localhost:8554/may_nen_khi_02
  ```

- **VLC**: *File → Open Network…* (macOS) hoặc *Media → Open Network Stream…* (Windows), dán link rồi bấm Open.
  Nếu hình không lên, vào *Preferences → Input / Codecs* và chọn *RTP over RTSP (TCP)*.
- **IINA** (macOS): *File → Open URL…*, dán link.
- **Điện thoại** cùng Wi-Fi: mở VLC, *Network Stream*, nhập `rtsp://<IP máy chạy demo>:8554/may_nen_khi_02`.
- **Kiểm tra nhanh** một luồng có sống không:

  ```sh
  ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name,width,height rtsp://localhost:8554/lo_hoi_05
  ```

Luồng chỉ tồn tại khi demo đang chạy (`docker ps` phải thấy `gauge-twin-sim-rtsp-publisher-1` và
`gauge-twin-mediamtx-1`).

## Dữ liệu đi đâu

1. `rtsp-publisher` (ffmpeg) phát lặp `data/sim-factory/<luồng>/video.mp4` lên MediaMTX, đóng vai camera IP.
2. Edge (`ds-sim` và `edge-agent`) mở luồng RTSP, cắt vùng đọc của từng đồng hồ và chạy model ngay tại edge.
3. Edge gửi về server qua MQTT chỉ các con số kèm độ tin cậy và cờ chất lượng. Không có ảnh trong dữ liệu đo.
4. Hai trường hợp có ảnh đi về, đều không lưu vào database:
   - trang chi tiết của một máy đang mở: edge gửi kèm khung hình vừa đọc để ảnh và số khớp nhau;
   - ảnh nhỏ trên trang tổng quan và lúc khai báo vùng đọc: server tự mở luồng camera lấy một khung hình.

## Thêm một camera giả

1. Đặt video vào `data/sim-factory/<tên_mới>/video.mp4`.
2. Chạy lại `make sim-down && make sim-up` với `SIM_DATA_DIR=$PWD/data/sim-factory`.
3. Trên giao diện, mục *Camera và khai báo*, thêm camera với địa chỉ `rtsp://mediamtx:8554/<tên_mới>` rồi khoanh
   vùng đọc cho từng đồng hồ.
4. Thêm máy mới vào `EDGE_MACHINES` của edge (dạng `NHA_MAY_1/XUONG_A/<MÃ_MÁY>`) và khởi động lại edge.

## Nguồn hình

Hình là ảnh và video thật ghép lại thành bảng đồng hồ, không phải quay tại một nhà máy:

- đồng hồ kim: video trong `data/sim-real/pump_man*`;
- bộ đếm giờ và bộ đếm sản lượng: ảnh của bộ TRODO;
- công tơ điện LCD: ảnh của bộ YUVA EB;
- màn hình nhiệt độ: ảnh của bộ seg7-cramatsu;
- màn LED tốc độ: ảnh của bộ seg7-industrial (không rõ giấy phép, chỉ dùng nội bộ, không đăng lại).

Ảnh bộ đếm và công tơ được chọn trong số những ảnh model đọc đúng, nên demo này không nói lên độ chính xác chung
của model.

## Giới hạn đã biết

- Bộ đếm và công tơ là ảnh tĩnh nên số không đổi; đồng hồ kim và màn nhiệt độ thì chạy.
- Hai màn LED tốc độ (`TRAM_BOM_01`, `MAY_EP_03`) đôi khi đọc sai một chữ số hoặc không ra số.
- `AP_SUAT_LAM_MAT` của `MAY_EP_03` chỉ đọc được khoảng một phần tư thời gian.
- Ba nhà máy dùng chung một edge; ngoài thực tế mỗi nhà máy có edge riêng.
- Vài thiết bị dùng chung hình giữa các máy, vì chỉ có 7 video đồng hồ kim và một màn nhiệt độ.
- Nhãn "Ảnh kém" hiện ở hầu hết các máy dù số đúng: công thức điểm chất lượng còn quá khắt khe.
