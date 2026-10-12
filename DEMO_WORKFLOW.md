# Workflow demo KaizenFlow

File này là kịch bản demo ngắn gọn để mở app lên và show được các tính năng chính theo đúng thứ tự, tránh bị lan man.

## 1. Mục tiêu demo

KaizenFlow nên được show theo flow này:

1. **Mô hình hoá workflow nhà máy**
2. **Chạy mô phỏng để thấy rủi ro / bottleneck**
3. **Sinh recommendation**
4. **So sánh before/after**
5. **Show live twin + feed + AGV map**
6. **Kết thúc ở dashboard / report để chốt giá trị**

Nếu đi đúng flow này thì người xem sẽ hiểu app không chỉ là "vẽ sơ đồ", mà là:

- có **model**
- có **simulation**
- có **prediction / nowcast**
- có **recommendation**
- có **live monitoring**
- có **compare / reporting**

## 2. Chuẩn bị trước khi demo

Chạy sẵn hệ thống:

```bash
docker compose up -d --build
python scripts/seed_demo.py
cd web
npm install
npm run dev
```

Mở web:

- `http://localhost:5173/`

Model nên dùng để show:

- **Nhanh, dễ hiểu:** `denso-mini`
- **Nhiều tính năng live hơn:** `denso-plant`

## 3. Workflow demo khuyên dùng (5-7 phút)

| Bước | Màn hình | URL | Thao tác | Tính năng được show |
|---|---|---|---|---|
| 1 | Tổng quan | `/` | Mở app, chỉ nhanh active runs / red alerts / model gần đây | App có overview cấp hệ thống |
| 2 | Dashboard vận hành | `/reports/operations` | Chọn model, nói nhanh app đang nối live + recommendation + đo hiệu quả trong một màn | Bức tranh tổng thể, dễ vào câu chuyện |
| 3 | Sơ đồ workflow | `/versions/:id` | Mở `denso-mini` hoặc `denso-plant`, zoom/pan, nói qua luồng vật tư | Model-based workflow editor |
| 4 | Scenario | `/versions/:id/scenarios` | Chọn scenario lỗi máy / thiếu xe / thiếu hàng | Kịch bản giả lập |
| 5 | Run / Control Room | `/runs/:id` | Mở run, play replay, chỉ vùng đỏ / bottleneck / alert | Simulation + explainability |
| 6 | Recommendations | `/runs/:id/recommendations` hoặc ngay trong Control Room | Áp recommendation và chạy lại | Decision support |
| 7 | Compare | `/compare?a=...&b=...` | So baseline với phương án áp dụng | Before/after validation |
| 8 | Live Connect | `/models/:key/connect` | Bật feed, auto-map binding, apply | Data mapping từ nguồn thật vào model |
| 9 | Live Twin | `/models/:key/live` | Show node đổi trạng thái, forecast from now, drift alerts | Live monitoring + nowcast |
| 10 | AGV Map | `/models/:key/map` | Show xe chạy, chặn lane, nhìn hiệu ứng | AGV / logistics digital twin |

## 4. Script nói theo từng màn

### Bước 1 - Tổng quan

Vào:

- `http://localhost:5173/`

Nói:

> Đây là màn tổng quan của toàn hệ thống. Ở đây thấy được run nào đang chạy, cảnh báo Đỏ mới nhất, và mô hình nào vừa hoạt động gần đây.

Chỉ nhanh:

- **Dashboard vận hành**

Không đứng quá lâu ở màn này.

### Bước 2 - Dashboard vận hành

Vào:

- `http://localhost:5173/reports/operations`

Nói:

> Màn này gom 3 câu hỏi quan trọng nhất: hệ thống có đang nhận live data không, hệ thống đang khuyên xử lý gì, và recommendation gần nhất có thật sự cải thiện KPI hay không.

Nên chỉ vào:

- `Tình trạng live`
- `Ưu tiên số 1`
- `Hiệu quả gần nhất`

Mục tiêu của màn này là **đặt bài toán** trước khi đi vào chi tiết.

### Bước 3 - Thiết bị và sơ đồ workflow

Đi từ:

- `Thiết bị` -> danh mục máy của nhà máy
- rồi `Mô hình` -> chọn model (hoặc mở trực tiếp version của model)

Nói:

> Trước hết là danh mục thiết bị: mỗi dòng là một cái máy có thật, định danh duy nhất trong toàn hệ thống. Tham số của máy và tín hiệu của nó khai ở đây một lần.
>
> Mô hình thì là một cách bố trí các thiết bị đó. Cột "Dùng trong" cho thấy một cái máy đang nằm trong mấy mô hình — sửa máy một chỗ, mọi mô hình thấy ngay, mà bản đã Publish thì không bị đổi theo.
>
> Đây là workflow vận hành của nhà máy dưới dạng model. Từ model này, app có thể sinh scenario, chạy simulation, và nối với dữ liệu live.

Điểm đáng show:

- `denso-plant` và `denso-plant-amr` dùng chung 23 thiết bị, chỉ khác đội xe kho B (`TUG_B` xe kéo so với `TUG_B_AMR`): đổi công nghệ xe không phải khai lại cả nhà máy.
- Thả một node trên sơ đồ sẽ mở hộp **chọn thiết bị** — node không tự sinh mã nữa.

Nên show:

- `denso-mini`: dễ hiểu, ngắn
- `denso-plant`: phức tạp hơn, nhiều kho / nhiều máy / nhiều tuyến AGV

Nếu cần thao tác nhanh:

- zoom / pan
- `Xếp ngang` hoặc `Xếp dọc`

### Bước 4 - Scenario

Vào tab:

- `Scenario`

Chọn một scenario kiểu:

- máy hỏng
- thiếu xe
- stock drain

Nói:

> Thay vì chờ lỗi xảy ra ngoài thực tế, mình dựng trước các giả thuyết vận hành để mô phỏng xem hệ thống phản ứng ra sao.

### Bước 5 - Run / Control Room

Mở run từ scenario.

Route:

- `/runs/:id`

Nói:

> Đây là chỗ app chuyển từ model tĩnh sang hành vi động. Mình thấy được luồng vật tư, điểm nghẽn, và rủi ro chuyển Đỏ theo thời gian.

Nên show:

- replay
- node/kho đổi trạng thái
- bottleneck
- red risk
- fault risk nếu có

Điểm cần chốt:

> App không chỉ báo lỗi, mà còn chỉ ra lỗi hình thành như thế nào trong toàn flow.

### Bước 6 - Recommendation

Ở run detail hoặc Control Room:

- mở recommendation
- bấm apply

Nói:

> Từ kết quả mô phỏng, hệ thống sinh recommendation có thể áp dụng ngay như bù hàng, thêm nguồn lực, hoặc thay đổi phương án vận hành.

Show:

- top recommendation
- score / red delta / throughput delta
- apply recommendation để tạo run mới

### Bước 7 - Compare

Vào:

- `/compare?a=<baseline>&b=<candidate>`

hoặc compare nhiều run từ dashboard vận hành.

Nói:

> Điểm quan trọng là recommendation không dừng ở mức gợi ý. Nó được đưa vào mô phỏng lại để kiểm chứng before/after.

Nên chỉ:

- `Red minutes`
- `Throughput`
- coverage / stockout nếu có

Thông điệp chốt:

> Đây là closed loop: predict -> recommend -> simulate again -> measure effect.

### Bước 8 - Kết nối dữ liệu

Vào:

- `/models/denso-plant/connect`

Thao tác:

1. **Bắt đầu phát dữ liệu giả lập**
2. **Gợi ý ghép tự động**
3. **Áp dụng**

Nói:

> Đây là lớp mapping giữa dữ liệu thiết bị ngoài đời và các subject trong model. Khi ghép xong, workflow bắt đầu có live state thật.

Điểm đáng show:

- mỗi nguồn dữ liệu map vào node/edge nào
- app không phụ thuộc cứng vào tên thiết bị
- tín hiệu của một **node** là tín hiệu của chính cái máy: ghép ở đây một lần thì mọi mô hình có máy đó đều dùng được, xem lại ở `Thiết bị` -> `Tín hiệu thiết bị`. Tín hiệu của **đường nối** thì vẫn thuộc riêng mô hình này.

### Bước 8b - Số đọc đồng hồ vào twin

Vào:

- `Thiết bị` -> `Tín hiệu thiết bị`

Nói:

> Đây là phần trả lời cho máy cũ không có PLC: camera đọc đồng hồ trên tủ điều khiển, edge chỉ gửi số về, và số đó vào thẳng twin.
>
> Nguồn hiện ở đây đúng tên topic mà edge publish. Ghép một lần cho cái máy, mọi mô hình có máy đó đều dùng được — vì tín hiệu là thuộc tính của máy, không của mô hình.

Điểm đáng show:

- nguồn `denso/{nhà máy}/{xưởng}/{máy}/telemetry`, trường `gauges.<mã đồng hồ>.value`
- cùng một máy, cùng một ghép nối, nhiều mô hình dùng
- số đọc chất lượng thấp (ảnh mờ, kim bị che) bị bỏ, không vào twin như một số đo

### Bước 9 - Live Twin

Vào:

- `/models/denso-plant/live`

Nói:

> Đây là digital twin ở thời gian thực. Workflow bây giờ không còn là giả lập offline nữa, mà đang nhận dữ liệu live và phản ánh trạng thái thật.

Nên show:

- feed đang chạy
- node đổi trạng thái
- hạt chạy trên edge
- drift alerts
- **Dự báo từ trạng thái live**

Nếu muốn có cao trào:

1. bơm sự cố
2. chạy nowcast
3. cho thấy risk tăng / drift xuất hiện

### Bước 10 - AGV Map

Vào:

- `/models/denso-plant/map`

Nói:

> Ngoài workflow logic, app còn có lớp vận chuyển nội bộ. Xe AGV chạy trên lane, có nghẽn, có chặn đường, có route thay thế.

Nên show:

- xe đang chạy
- chọn một lane
- **Chặn làn này**
- xem xe dồn hoặc đổi đường

Nếu còn thời gian:

- show phần calibration / travel-time compare

## 5. Demo cực ngắn (2-3 phút)

Nếu phải demo nhanh, đi theo thứ tự này:

1. `/reports/operations`
2. mở `Live Twin`
3. bơm sự cố + chạy forecast
4. mở compare
5. mở AGV map

Câu chuyện ngắn:

> App nhận dữ liệu live, dự báo rủi ro từ trạng thái hiện tại, đề xuất phương án xử lý, rồi kiểm chứng hiệu quả bằng simulation và compare.

## 6. Demo chuẩn để "wow"

Nếu muốn show đủ chiều sâu:

1. **Overview** -> đặt context
2. **Editor** -> app có model thật
3. **Scenario** -> app có giả thuyết vận hành
4. **Control Room** -> app có simulation
5. **Recommendation** -> app có decision support
6. **Compare** -> app có evidence
7. **Connect + Live** -> app có live twin
8. **AGV Map** -> app có logistics layer
9. **Operations Dashboard** -> app có executive view

## 7. Thứ tự route gợi ý để đi live

```text
/ 
-> /reports/operations
-> /models
-> /versions/:id
-> /versions/:id/scenarios
-> /runs/:id
-> /compare?a=...&b=...
-> /models/:key/connect
-> /models/:key/live
-> /models/:key/map
```

## 8. Mẫu lời chốt demo

> KaizenFlow không chỉ là công cụ vẽ workflow. Nó nối được 3 lớp với nhau: model vận hành, simulation để dự báo và kiểm chứng, và live data để phản ánh trạng thái thật. Nhờ vậy hệ thống không chỉ "thấy đang có vấn đề", mà còn trả lời được "nếu xử lý theo phương án A hay B thì KPI sẽ đổi ra sao".

## 9. Gợi ý model để dùng

### Nếu demo cho người mới

- dùng `denso-mini`

Lý do:

- flow ngắn
- dễ hiểu
- ít bị rối

### Nếu demo cho người kỹ thuật / quản lý vận hành

- dùng `denso-plant`

Lý do:

- có connect
- có live twin
- có AGV map
- có nhiều điểm để show bottleneck và calibration

