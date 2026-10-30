FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
# Библиотека для сканирования камерой на iPhone (на Android работает встроенный распознаватель)
RUN mkdir -p public/vendor && \
    wget -q -O public/vendor/html5-qrcode.min.js https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js || \
    echo "html5-qrcode не скачалась — будет грузиться из интернета"
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
