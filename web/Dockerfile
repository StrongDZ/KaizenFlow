# Giao diện KaizenFlow đóng gói sẵn để chạy thử không cần Node: build Vite rồi phục vụ file tĩnh bằng nginx.
# Dev vẫn dùng `npm run dev` (cổng 5173). Các địa chỉ API do TRÌNH DUYỆT gọi nên được nhúng lúc build.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_URL=http://localhost:8080
ARG VITE_GAUGE_API_URL=http://localhost:8092
ARG VITE_GAUGE_CONFIG_API_URL=http://localhost:8090
ENV VITE_API_URL=$VITE_API_URL VITE_GAUGE_API_URL=$VITE_GAUGE_API_URL VITE_GAUGE_CONFIG_API_URL=$VITE_GAUGE_CONFIG_API_URL
# File build ra thư mục static/ chứ không phải assets/ mặc định: /assets là đường dẫn của mục Thiết bị.
RUN npx vite build --assetsDir static

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
