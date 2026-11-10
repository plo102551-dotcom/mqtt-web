/**
 * ===================================================================
 * ESP8266 & DHT11 IOT DASHBOARD - JAVASCRIPT LOGIC
 * Kết nối EMQX Broker qua WebSocket (WSS: 8084)
 * Nhận và phân tích JSON: {"temperature":"78.00", "humidity":"78.00"}
 * Topic: esp8266/dht11
 * ===================================================================
 */

// 1. CẤU HÌNH MẶC ĐỊNH
const DEFAULT_CONFIG = {
    host: "wd817fa2.ala.asia-southeast1.emqxsl.com",
    port: 8084, // Cổng WebSocket Secure (WSS) trên EMQX Cloud cho trình duyệt Web
    path: "/mqtt",
    username: "iot",
    password: "P557724",
    topic: "esp8266/dht11",
    clientIdPrefix: "dashboard_web"
};

let currentConfig = { ...DEFAULT_CONFIG };

// Load cấu hình đã lưu trong localStorage (nếu có)
try {
    const savedCfg = localStorage.getItem('mqtt_iot_config');
    if (savedCfg) {
        currentConfig = Object.assign({}, DEFAULT_CONFIG, JSON.parse(savedCfg));
    }
} catch (e) {
    console.warn("Không thể đọc localStorage", e);
}

// Biến trạng thái toàn cục
let mqttClient = null;
let isManuallyDisconnected = false;
let packetCount = 0;
let historyRecords = [];

// Thống kê Min/Max
let stats = {
    tempMin: null,
    tempMax: null,
    humMin: null,
    humMax: null
};

// Chu vi vòng tròn SVG r=68: 2 * PI * 68 = 427.26
const GAUGE_CIRCUMFERENCE = 427.26;

// Biến điều khiển các đường trang trí trên biểu đồ
let showThresholdLines = true;
let showCrosshairs = true;
let chartMousePos = null;

// ================= 2. KHỞI TẠO BIỂU ĐỒ (CHART.JS) =================
let telemetryChart = null;

// Plugin 1: Các đường kẻ ngưỡng kỹ thuật & Dải an toàn (Threshold Lines & Comfort Zone)
const thresholdLinesPlugin = {
    id: 'thresholdLinesPlugin',
    beforeDraw(chart) {
        if (!showThresholdLines) return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.yTemp) return;
        const { top, bottom, left, width } = chartArea;

        // Vẽ dải vùng nhiệt độ lý tưởng (22°C - 28°C) với hiệu ứng bóng mờ nhẹ
        const y22 = scales.yTemp.getPixelForValue(22);
        const y28 = scales.yTemp.getPixelForValue(28);
        if (y22 >= top && y28 <= bottom) {
            ctx.save();
            ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
            ctx.fillRect(left, Math.min(y22, y28), width, Math.abs(y22 - y28));
            ctx.restore();
        }
    },
    afterDraw(chart) {
        if (!showThresholdLines) return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.yTemp || !scales.yHum) return;
        const { top, bottom, left, right } = chartArea;

        function drawGuideLine(yPixel, color, labelText, align = 'right', dash = [6, 4]) {
            if (yPixel < top - 8 || yPixel > bottom + 8) return;

            ctx.save();
            ctx.setLineDash(dash);
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;

            // Đường nét đứt ngang
            ctx.beginPath();
            ctx.moveTo(left, yPixel);
            ctx.lineTo(right, yPixel);
            ctx.stroke();

            // Vẽ badge nhãn
            ctx.setLineDash([]);
            ctx.shadowBlur = 0;
            ctx.font = 'bold 10px "Plus Jakarta Sans", sans-serif';
            const textWidth = ctx.measureText(labelText).width;
            const badgeW = textWidth + 16;
            const badgeH = 18;
            const badgeY = yPixel - badgeH / 2;
            let badgeX = align === 'right' ? (right - badgeW - 8) : (left + 8);

            // Nền badge
            ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
                ctx.fill();
            } else {
                ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
            }

            // Viền badge
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.stroke();

            // Chữ
            ctx.fillStyle = color;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(labelText, badgeX + badgeW / 2, yPixel);
            ctx.restore();
        }

        // 1. Ngưỡng cảnh báo nhiệt cao: 35°C
        drawGuideLine(scales.yTemp.getPixelForValue(35), '#ef4444', '⚡ 35°C Cảnh Báo Nhiệt Cao', 'right', [6, 4]);

        // 2. Nhiệt độ tối ưu: 26°C
        drawGuideLine(scales.yTemp.getPixelForValue(26), '#10b981', '🌿 26°C Nhiệt Độ Tối Ưu', 'right', [6, 4]);

        // 3. Độ ẩm lý tưởng: 60%
        drawGuideLine(scales.yHum.getPixelForValue(60), '#06b6d4', '💧 60% Độ Ẩm Lý Tưởng', 'left', [5, 5]);

        // 4. Ngưỡng khô hanh: 40%
        drawGuideLine(scales.yHum.getPixelForValue(40), '#f59e0b', '☀️ 40% Ngưỡng Khô Hanh', 'left', [5, 5]);
    }
};

// Plugin 2: Trục dóng trỏ chuột thời gian thực (Interactive Crosshair Lines)
const crosshairPlugin = {
    id: 'crosshairPlugin',
    afterDraw(chart) {
        if (!showCrosshairs || !chartMousePos) return;
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        const { top, bottom, left, right } = chartArea;
        const { x: mx, y: my } = chartMousePos;

        if (mx < left || mx > right || my < top || my > bottom) return;

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
        ctx.shadowColor = 'rgba(56, 189, 248, 0.9)';
        ctx.shadowBlur = 6;

        // Trục dọc theo tọa độ X
        ctx.beginPath();
        ctx.moveTo(mx, top);
        ctx.lineTo(mx, bottom);
        ctx.stroke();

        // Trục ngang theo tọa độ Y
        ctx.beginPath();
        ctx.moveTo(left, my);
        ctx.lineTo(right, my);
        ctx.stroke();

        // Điểm tâm ngắm giao nhau
        ctx.setLineDash([]);
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(mx, my, 4, 0, Math.PI * 2);
        ctx.fill();

        // Dóng giá trị lên trục Y nhiệt độ (bên trái)
        if (scales.yTemp) {
            const val = scales.yTemp.getValueForPixel(my);
            if (val !== undefined) {
                const txt = `${val.toFixed(1)}°C`;
                ctx.fillStyle = '#f97316';
                ctx.fillRect(left - 42, my - 9, 40, 18);
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 10px JetBrains Mono, monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(txt, left - 22, my);
            }
        }

        // Dóng giá trị lên trục Y độ ẩm (bên phải)
        if (scales.yHum) {
            const val = scales.yHum.getValueForPixel(my);
            if (val !== undefined) {
                const txt = `${val.toFixed(1)}%`;
                ctx.fillStyle = '#06b6d4';
                ctx.fillRect(right + 2, my - 9, 38, 18);
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 10px JetBrains Mono, monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(txt, right + 21, my);
            }
        }

        ctx.restore();
    }
};

function initChart() {
    const ctx = document.getElementById('telemetryChart');
    if (!ctx) return;

    const isDark = document.body.classList.contains('dark-theme');
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.07)';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    telemetryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Nhiệt Độ (°C)',
                    data: [],
                    borderColor: '#f97316',
                    backgroundColor: 'rgba(249, 115, 22, 0.12)',
                    borderWidth: 2.5,
                    pointBackgroundColor: '#f97316',
                    pointBorderColor: '#fff',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    tension: 0.35,
                    fill: true,
                    yAxisID: 'yTemp'
                },
                {
                    label: 'Độ Ẩm (% RH)',
                    data: [],
                    borderColor: '#06b6d4',
                    backgroundColor: 'rgba(6, 182, 212, 0.12)',
                    borderWidth: 2.5,
                    pointBackgroundColor: '#06b6d4',
                    pointBorderColor: '#fff',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    tension: 0.35,
                    fill: true,
                    yAxisID: 'yHum'
                },
                {
                    label: 'Xu Hướng Nhiệt (MA-5)',
                    data: [],
                    borderColor: '#fbbf24',
                    borderDash: [5, 4],
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.4,
                    fill: false,
                    yAxisID: 'yTemp'
                }
            ]
        },
        plugins: [thresholdLinesPlugin, crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: textColor,
                        font: { family: 'Plus Jakarta Sans', weight: '600', size: 12 },
                        usePointStyle: true,
                        boxWidth: 8
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                    titleColor: '#f8fafc',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(56, 189, 248, 0.3)',
                    borderWidth: 1,
                    padding: 10,
                    boxPadding: 6,
                    usePointStyle: true
                }
            },
            scales: {
                x: {
                    grid: {
                        color: gridColor,
                        borderDash: [4, 4]
                    },
                    ticks: {
                        color: textColor,
                        font: { family: 'JetBrains Mono', size: 11 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 7
                    }
                },
                yTemp: {
                    type: 'linear',
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Nhiệt độ (°C)',
                        color: '#f97316',
                        font: { family: 'Plus Jakarta Sans', weight: '700', size: 11 }
                    },
                    grid: {
                        color: gridColor,
                        borderDash: [4, 4]
                    },
                    ticks: { color: textColor },
                    suggestedMin: 15,
                    suggestedMax: 45
                },
                yHum: {
                    type: 'linear',
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Độ ẩm (% RH)',
                        color: '#06b6d4',
                        font: { family: 'Plus Jakarta Sans', weight: '700', size: 11 }
                    },
                    grid: { drawOnChartArea: false },
                    ticks: { color: textColor },
                    min: 0,
                    max: 100
                }
            }
        }
    });

    // Bắt sự kiện rê chuột trên Canvas để vẽ đường dóng Crosshair
    if (!ctx.hasMouseTracking) {
        ctx.hasMouseTracking = true;
        ctx.addEventListener('mousemove', (e) => {
            if (!showCrosshairs || !telemetryChart) return;
            const rect = ctx.getBoundingClientRect();
            chartMousePos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            telemetryChart.draw();
        });

        ctx.addEventListener('mouseleave', () => {
            chartMousePos = null;
            if (telemetryChart) telemetryChart.draw();
        });
    }
}

function addDataToChart(timeLabel, temp, hum) {
    if (!telemetryChart) return;

    telemetryChart.data.labels.push(timeLabel);
    telemetryChart.data.datasets[0].data.push(temp);
    telemetryChart.data.datasets[1].data.push(hum);

    // Tính đường xu hướng trung bình trượt 5 điểm gần nhất (MA-5)
    const temps = telemetryChart.data.datasets[0].data;
    const windowSlice = temps.slice(-5);
    const ma = windowSlice.reduce((a, b) => a + b, 0) / windowSlice.length;
    telemetryChart.data.datasets[2].data.push(Math.round(ma * 100) / 100);

    // Giữ tối đa 20 điểm dữ liệu trên biểu đồ để chuyển động mượt mà
    if (telemetryChart.data.labels.length > 20) {
        telemetryChart.data.labels.shift();
        telemetryChart.data.datasets[0].data.shift();
        telemetryChart.data.datasets[1].data.shift();
        telemetryChart.data.datasets[2].data.shift();
    }

    telemetryChart.update();
}

function clearChartData() {
    if (!telemetryChart) return;
    telemetryChart.data.labels = [];
    telemetryChart.data.datasets[0].data = [];
    telemetryChart.data.datasets[1].data = [];
    telemetryChart.data.datasets[2].data = [];
    telemetryChart.update();
    showToast("Đã xóa dữ liệu biểu đồ", "info");
}

// ================= 3. CÔNG THỨC MÔI TRƯỜNG (HEAT INDEX & DEW POINT) =================
// Tính Heat Index (Chỉ số cảm nhận thực)
function calculateHeatIndex(tempC, humidity) {
    const t = (tempC * 9/5) + 32; // Đổi sang độ F để áp dụng công thức NOAA
    const r = humidity;

    let hi = 0.5 * (t + 61.0 + ((t - 68.0) * 1.2) + (r * 0.094));

    if (hi >= 80) {
        hi = -42.379 + 2.04901523 * t + 10.14333127 * r - 0.22475541 * t * r 
             - 0.00683783 * t * t - 0.05481717 * r * r + 0.00122874 * t * t * r 
             + 0.00085282 * t * r * r - 0.00000199 * t * t * r * r;
    }

    const hiC = (hi - 32) * 5/9; // Đổi lại °C
    return Math.round(hiC * 10) / 10;
}

// Tính Điểm sương (Dew Point) theo công thức Magnus
function calculateDewPoint(tempC, humidity) {
    const a = 17.27;
    const b = 237.7;
    const alpha = ((a * tempC) / (b + tempC)) + Math.log(humidity / 100.0);
    const dp = (b * alpha) / (a - alpha);
    return Math.round(dp * 10) / 10;
}

// ================= 4. CẬP NHẬT GIAO DIỆN KHI CÓ DỮ LIỆU MỚI =================
function updateDashboard(temp, hum, rawJsonStr) {
    packetCount++;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('vi-VN');
    const fullDateStr = now.toLocaleDateString('vi-VN') + ' ' + timeStr;

    // --- Cập nhật Thống kê Min/Max ---
    if (stats.tempMin === null || temp < stats.tempMin) stats.tempMin = temp;
    if (stats.tempMax === null || temp > stats.tempMax) stats.tempMax = temp;
    if (stats.humMin === null || hum < stats.humMin) stats.humMin = hum;
    if (stats.humMax === null || hum > stats.humMax) stats.humMax = hum;

    // --- Thẻ 1: Nhiệt độ ---
    document.getElementById('tempVal').innerText = temp.toFixed(1);
    document.getElementById('tempMin').innerText = stats.tempMin.toFixed(1);
    document.getElementById('tempMax').innerText = stats.tempMax.toFixed(1);
    const tempF = (temp * 9/5) + 32;
    document.getElementById('tempFahrenheit').innerText = tempF.toFixed(1);

    // Vòng đo nhiệt độ: Giả sử dải nhiệt độ 0°C -> 100°C
    const tempPercent = Math.max(0, Math.min(100, temp));
    const tempOffset = GAUGE_CIRCUMFERENCE - (tempPercent / 100) * GAUGE_CIRCUMFERENCE;
    document.getElementById('tempGaugeBar').style.strokeDashoffset = tempOffset;
    document.getElementById('tempRangeFill').style.width = `${tempPercent}%`;

    // Đánh giá nhiệt độ
    const tempStatusEl = document.getElementById('tempStatus');
    if (temp < 18) {
        tempStatusEl.className = 'badge-status status-warning';
        tempStatusEl.innerText = 'Trời Lạnh';
    } else if (temp <= 30) {
        tempStatusEl.className = 'badge-status status-normal';
        tempStatusEl.innerText = 'Dễ Chịu';
    } else if (temp <= 36) {
        tempStatusEl.className = 'badge-status status-warning';
        tempStatusEl.innerText = 'Khá Nóng';
    } else {
        tempStatusEl.className = 'badge-status status-danger';
        tempStatusEl.innerText = 'Nhiệt Độ Rất Cao';
    }

    // --- Thẻ 2: Độ ẩm ---
    document.getElementById('humVal').innerText = hum.toFixed(1);
    document.getElementById('humMin').innerText = stats.humMin.toFixed(1);
    document.getElementById('humMax').innerText = stats.humMax.toFixed(1);

    // Vòng đo độ ẩm: Dải 0% -> 100%
    const humPercent = Math.max(0, Math.min(100, hum));
    const humOffset = GAUGE_CIRCUMFERENCE - (humPercent / 100) * GAUGE_CIRCUMFERENCE;
    document.getElementById('humGaugeBar').style.strokeDashoffset = humOffset;
    document.getElementById('humRangeFill').style.width = `${humPercent}%`;

    // Đánh giá độ ẩm
    const humStatusEl = document.getElementById('humStatus');
    const humDescEl = document.getElementById('humEnvDesc');
    if (hum < 40) {
        humStatusEl.className = 'badge-status status-warning';
        humStatusEl.innerText = 'Không Khí Khô';
        humDescEl.innerText = 'Cần bù ẩm';
    } else if (hum <= 70) {
        humStatusEl.className = 'badge-status status-ideal';
        humStatusEl.innerText = 'Độ Ẩm Lý Tưởng';
        humDescEl.innerText = 'Thoải mái';
    } else {
        humStatusEl.className = 'badge-status status-danger';
        humStatusEl.innerText = 'Độ Ẩm Quá Cao';
        humDescEl.innerText = 'Dễ nấm mốc';
    }

    // --- Thẻ 3: Heat Index & Dew Point ---
    const heatIndex = calculateHeatIndex(temp, hum);
    const dewPoint = calculateDewPoint(temp, hum);
    document.getElementById('heatIndexVal').innerText = isNaN(heatIndex) ? '--' : heatIndex;
    document.getElementById('dewPointVal').innerText = isNaN(dewPoint) ? '--' : dewPoint;
    document.getElementById('packetCountVal').innerText = packetCount;
    document.getElementById('lastReceivedTime').innerText = fullDateStr;

    // --- Cập nhật Raw JSON Terminal ---
    try {
        const parsed = JSON.parse(rawJsonStr);
        document.getElementById('rawJsonCode').innerText = JSON.stringify(parsed, null, 2);
    } catch {
        document.getElementById('rawJsonCode').innerText = rawJsonStr;
    }

    // --- Thêm vào Biểu đồ ---
    addDataToChart(timeStr, temp, hum);

    // --- Thêm vào Bảng Lịch sử Telemetry ---
    appendTelemetryTableRow(packetCount, timeStr, currentConfig.topic, temp, hum, heatIndex, rawJsonStr);
}

// Chèn dòng vào Bảng
function appendTelemetryTableRow(stt, timeStr, topic, temp, hum, heatIndex, rawJsonStr) {
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;

    // Xóa dòng empty state nếu đang có
    const emptyRow = tbody.querySelector('.empty-row');
    if (emptyRow) {
        tbody.innerHTML = '';
    }

    let statusHtml = '<span class="badge-status status-normal">Bình thường</span>';
    if (temp > 35 || hum > 80) {
        statusHtml = '<span class="badge-status status-danger">Cảnh báo cao</span>';
    } else if (temp < 18 || hum < 40) {
        statusHtml = '<span class="badge-status status-warning">Chú ý ngưỡng</span>';
    }

    const tr = document.createElement('tr');
    tr.className = 'row-new';
    tr.innerHTML = `
        <td><strong>#${stt}</strong></td>
        <td><i class="fa-regular fa-clock"></i> ${timeStr}</td>
        <td><code>${topic}</code></td>
        <td><strong style="color: var(--temp-color);">${temp.toFixed(2)}</strong></td>
        <td><strong style="color: var(--hum-color);">${hum.toFixed(2)}</strong></td>
        <td>${isNaN(heatIndex) ? '--' : heatIndex + ' °C'}</td>
        <td>${statusHtml}</td>
        <td><code>${escapeHtml(rawJsonStr)}</code></td>
    `;

    tbody.insertBefore(tr, tbody.firstChild);

    // Giữ tối đa 50 dòng trong bảng
    while (tbody.children.length > 50) {
        tbody.removeChild(tbody.lastChild);
    }

    // Lưu vào mảng lịch sử phục vụ xuất file CSV
    historyRecords.unshift({
        stt: stt,
        time: timeStr,
        topic: topic,
        temp: temp,
        hum: hum,
        heatIndex: heatIndex,
        raw: rawJsonStr
    });

    document.getElementById('recordCounter').innerText = `${historyRecords.length} bản ghi`;
}

// Thoát ký tự HTML an toàn
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ================= 5. KẾT NỐI MQTT BROKER (MQTT.JS OVER WEBSOCKET) =================
function connectMqtt() {
    isManuallyDisconnected = false;
    updateConnectionUI('connecting', 'Đang kết nối EMQX...');

    // Tạo Client ID ngẫu nhiên duy nhất
    const clientId = `${currentConfig.clientIdPrefix}_${Math.random().toString(16).substr(2, 8)}`;

    // Tạo URL WebSocket: wss://host:8084/mqtt
    const protocol = currentConfig.port == 8083 ? 'ws' : 'wss';
    const connectUrl = `${protocol}://${currentConfig.host}:${currentConfig.port}${currentConfig.path}`;

    console.log(`[MQTT] Đang kết nối tới ${connectUrl} với Client ID: ${clientId}`);

    const options = {
        clientId: clientId,
        username: currentConfig.username,
        password: currentConfig.password,
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 4000,
        keepalive: 60
    };

    try {
        if (mqttClient) {
            mqttClient.end(true);
        }

        // Gọi thư viện mqtt.connect
        mqttClient = mqtt.connect(connectUrl, options);

        mqttClient.on('connect', () => {
            console.log('[MQTT] Kết nối thành công tới EMQX Cloud!');
            updateConnectionUI('connected', 'Đã kết nối (Online)');
            showToast('Kết nối thành công tới Broker EMQX!', 'success');

            // Đăng ký nhận tin từ topic
            mqttClient.subscribe(currentConfig.topic, { qos: 0 }, (err) => {
                if (!err) {
                    console.log(`[MQTT] Đã Subscribe thành công topic: ${currentConfig.topic}`);
                    showToast(`Đã theo dõi topic: ${currentConfig.topic}`, 'info');
                } else {
                    console.error('[MQTT] Lỗi Subscribe:', err);
                    showToast(`Lỗi theo dõi topic: ${err.message}`, 'danger');
                }
            });
        });

        mqttClient.on('message', (topic, message) => {
            const payloadStr = message.toString();
            console.log(`[MQTT] Nhận tin từ [${topic}]:`, payloadStr);

            try {
                // Xử lý gói tin dạng JSON: {"temperature":"78.00", "humidity":"78.00"}
                const data = JSON.parse(payloadStr);

                let temp = parseFloat(data.temperature);
                let hum = parseFloat(data.humidity);

                if (!isNaN(temp) && !isNaN(hum)) {
                    updateDashboard(temp, hum, payloadStr);
                } else {
                    console.warn('[MQTT] Dữ liệu JSON thiếu trường temperature hoặc humidity hợp lệ:', data);
                    showToast('Nhận được JSON nhưng giá trị nhiệt độ/độ ẩm không hợp lệ!', 'warning');
                }
            } catch (err) {
                console.error('[MQTT] Lỗi giải mã JSON:', err, payloadStr);
                // Trường hợp nhận chuỗi text không phải JSON
                document.getElementById('rawJsonCode').innerText = `// Dữ liệu nhận được không phải chuẩn JSON:\n${payloadStr}`;
                showToast('Gói tin nhận về không đúng cú pháp JSON!', 'warning');
            }
        });

        mqttClient.on('reconnect', () => {
            if (!isManuallyDisconnected) {
                console.log('[MQTT] Đang thử kết nối lại...');
                updateConnectionUI('connecting', 'Đang kết nối lại...');
            }
        });

        mqttClient.on('close', () => {
            console.log('[MQTT] Kết nối đã đóng.');
            if (isManuallyDisconnected) {
                updateConnectionUI('disconnected', 'Đã ngắt kết nối');
            } else {
                updateConnectionUI('connecting', 'Mất kết nối, đang thử lại...');
            }
        });

        mqttClient.on('error', (err) => {
            console.error('[MQTT] Lỗi kết nối:', err);
            updateConnectionUI('disconnected', 'Lỗi kết nối');
            showToast(`Lỗi kết nối MQTT: ${err.message || 'Không thể kết nối broker'}`, 'danger');
        });

    } catch (e) {
        console.error('[MQTT] Exception khi khởi tạo kết nối:', e);
        updateConnectionUI('disconnected', 'Lỗi khởi tạo');
        showToast('Lỗi khi thiết lập kết nối MQTT!', 'danger');
    }
}

function disconnectMqtt() {
    isManuallyDisconnected = true;
    if (mqttClient) {
        mqttClient.end(true);
        mqttClient = null;
    }
    updateConnectionUI('disconnected', 'Đã ngắt kết nối');
    showToast('Đã chủ động ngắt kết nối MQTT.', 'warning');
}

// Cập nhật trạng thái hiển thị trên Header
function updateConnectionUI(state, text) {
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const brandIcon = document.getElementById('brandStatusIcon');
    const btnConnectText = document.getElementById('btnConnectText');
    const btnConnect = document.getElementById('btnConnectToggle');

    dot.className = `status-dot ${state}`;
    statusText.innerText = text;

    if (state === 'connected') {
        brandIcon.className = 'fa-solid fa-wifi';
        brandIcon.style.color = '#10b981';
        btnConnectText.innerText = 'Ngắt kết nối';
        btnConnect.className = 'btn-action btn-outline';
    } else {
        brandIcon.className = 'fa-solid fa-wifi-slash';
        brandIcon.style.color = '#ef4444';
        btnConnectText.innerText = 'Kết nối';
        btnConnect.className = 'btn-action btn-primary';
    }
}

// ================= 6. BỘ GIẢ LẬP PHÁT TIN (TEST PUBLISHER) =================
// Cho phép gửi thử gói tin JSON lên topic để kiểm tra dashboard ngay cả khi chưa cắm ESP8266
function publishTestMessage(tempVal, humVal) {
    if (!mqttClient || !mqttClient.connected) {
        showToast('Bạn cần kết nối đến Broker trước khi phát tin test!', 'warning');
        return;
    }

    const t = parseFloat(tempVal).toFixed(2);
    const h = parseFloat(humVal).toFixed(2);

    // Tạo đúng chuẩn JSON yêu cầu: {"temperature":"78.00", "humidity":"78.00"}
    const payload = JSON.stringify({
        temperature: t,
        humidity: h
    });

    mqttClient.publish(currentConfig.topic, payload, { qos: 0 }, (err) => {
        if (!err) {
            showToast(`Đã gửi gói tin test: T=${t}°C, H=${h}%`, 'success');
        } else {
            showToast(`Lỗi khi gửi test: ${err.message}`, 'danger');
        }
    });
}

// ================= 7. XUẤT FILE CSV & TOAST NOTIFICATION =================
function exportTableToCsv() {
    if (historyRecords.length === 0) {
        showToast('Chưa có dữ liệu nào để xuất CSV!', 'warning');
        return;
    }

    let csvContent = "\uFEFF"; // UTF-8 BOM cho Excel
    csvContent += "STT,Thoi Gian,Topic,Nhiet Do (C),Do Am (%),Chi So Cam Giac (C),Goi Tin JSON Goc\n";

    historyRecords.forEach(r => {
        const cleanRaw = `"${r.raw.replace(/"/g, '""')}"`;
        csvContent += `${r.stt},"${r.time}","${r.topic}",${r.temp},${r.hum},${r.heatIndex},${cleanRaw}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `ESP8266_DHT11_Telemetry_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('Đã tải xuống file CSV thành công!', 'success');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'danger') icon = 'fa-circle-exclamation';
    if (type === 'warning') icon = 'fa-triangle-exclamation';

    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ================= 8. GẮN SỰ KIỆN GIAO DIỆN (EVENT LISTENERS) =================
document.addEventListener('DOMContentLoaded', () => {
    // 1. Khởi tạo biểu đồ
    initChart();

    // 2. Cập nhật thông tin Header
    document.getElementById('metaHostText').innerText = currentConfig.host;
    document.getElementById('metaTopicText').innerText = currentConfig.topic;

    // 3. Tự động kết nối MQTT khi mở trang
    connectMqtt();

    // 4. Nút Kết nối / Ngắt kết nối
    document.getElementById('btnConnectToggle').addEventListener('click', () => {
        if (mqttClient && mqttClient.connected) {
            disconnectMqtt();
        } else {
            connectMqtt();
        }
    });

    // 5. Nút Gửi tin Test ngẫu nhiên
    document.getElementById('btnSimulate').addEventListener('click', () => {
        const randTemp = (25 + Math.random() * 12).toFixed(2);
        const randHum = (50 + Math.random() * 35).toFixed(2);
        publishTestMessage(randTemp, randHum);
    });

    // 6. Nút Publish Test tùy chỉnh ở khung Terminal
    document.getElementById('btnPublishCustom').addEventListener('click', () => {
        const temp = document.getElementById('simTempInput').value;
        const hum = document.getElementById('simHumInput').value;
        publishTestMessage(temp, hum);
    });

    // 7. Nút Sao chép JSON
    document.getElementById('btnCopyJson').addEventListener('click', () => {
        const codeText = document.getElementById('rawJsonCode').innerText;
        navigator.clipboard.writeText(codeText).then(() => {
            showToast('Đã sao chép gói tin JSON vào Clipboard!', 'success');
        });
    });

    // 8. Nút Xóa biểu đồ & Bật/Tắt các đường kẻ trang trí
    document.getElementById('btnClearChart').addEventListener('click', clearChartData);

    const btnToggleLines = document.getElementById('btnToggleLines');
    if (btnToggleLines) {
        btnToggleLines.addEventListener('click', () => {
            showThresholdLines = !showThresholdLines;
            btnToggleLines.classList.toggle('active', showThresholdLines);
            if (telemetryChart) telemetryChart.update();
            showToast(showThresholdLines ? 'Đã bật hiển thị các đường kẻ chuẩn' : 'Đã ẩn các đường kẻ chuẩn', 'info');
        });
    }

    const btnToggleCrosshair = document.getElementById('btnToggleCrosshair');
    if (btnToggleCrosshair) {
        btnToggleCrosshair.addEventListener('click', () => {
            showCrosshairs = !showCrosshairs;
            btnToggleCrosshair.classList.toggle('active', showCrosshairs);
            if (!showCrosshairs) chartMousePos = null;
            if (telemetryChart) telemetryChart.draw();
            showToast(showCrosshairs ? 'Đã bật đường dóng tọa độ trỏ chuột' : 'Đã tắt đường dóng trỏ chuột', 'info');
        });
    }

    document.getElementById('btnClearHistory').addEventListener('click', () => {
        historyRecords = [];
        packetCount = 0;
        document.getElementById('packetCountVal').innerText = '0';
        document.getElementById('recordCounter').innerText = '0 bản ghi';
        document.getElementById('historyTableBody').innerHTML = `
            <tr class="empty-row">
                <td colspan="8">
                    <div class="empty-state">
                        <i class="fa-solid fa-tower-broadcast"></i>
                        <p>Chưa có gói tin nào. Bảng đã được xóa trắng.</p>
                    </div>
                </td>
            </tr>
        `;
        showToast('Đã xóa toàn bộ lịch sử bảng!', 'info');
    });

    // 9. Nút Xuất CSV
    document.getElementById('btnExportCsv').addEventListener('click', exportTableToCsv);

    // 10. Chuyển đổi giao diện Sáng / Tối
    const btnTheme = document.getElementById('btnThemeToggle');
    btnTheme.addEventListener('click', () => {
        const isDark = document.body.classList.toggle('dark-theme');
        document.body.classList.toggle('light-theme', !isDark);
        btnTheme.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
        
        // Vẽ lại chart theo theme mới (giữ nguyên dữ liệu hiện có)
        if (telemetryChart) {
            const oldLabels = [...telemetryChart.data.labels];
            const oldTemp = [...telemetryChart.data.datasets[0].data];
            const oldHum = [...telemetryChart.data.datasets[1].data];
            const oldMa = [...telemetryChart.data.datasets[2].data];
            telemetryChart.destroy();
            initChart();
            telemetryChart.data.labels = oldLabels;
            telemetryChart.data.datasets[0].data = oldTemp;
            telemetryChart.data.datasets[1].data = oldHum;
            telemetryChart.data.datasets[2].data = oldMa;
            telemetryChart.update();
        }
    });

    // 11. Modal Cài đặt MQTT
    const modalConfig = document.getElementById('modalConfig');
    document.getElementById('btnOpenConfig').addEventListener('click', () => {
        document.getElementById('cfgHost').value = currentConfig.host;
        document.getElementById('cfgPort').value = currentConfig.port;
        document.getElementById('cfgPath').value = currentConfig.path;
        document.getElementById('cfgUser').value = currentConfig.username;
        document.getElementById('cfgPass').value = currentConfig.password;
        document.getElementById('cfgTopic').value = currentConfig.topic;
        document.getElementById('cfgClientId').value = currentConfig.clientIdPrefix;
        modalConfig.classList.add('active');
    });

    document.getElementById('btnCloseConfigModal').addEventListener('click', () => {
        modalConfig.classList.remove('active');
    });

    document.getElementById('btnResetDefaultConfig').addEventListener('click', () => {
        document.getElementById('cfgHost').value = DEFAULT_CONFIG.host;
        document.getElementById('cfgPort').value = DEFAULT_CONFIG.port;
        document.getElementById('cfgPath').value = DEFAULT_CONFIG.path;
        document.getElementById('cfgUser').value = DEFAULT_CONFIG.username;
        document.getElementById('cfgPass').value = DEFAULT_CONFIG.password;
        document.getElementById('cfgTopic').value = DEFAULT_CONFIG.topic;
        document.getElementById('cfgClientId').value = DEFAULT_CONFIG.clientIdPrefix;
        showToast('Đã khôi phục thông số ban đầu', 'info');
    });

    document.getElementById('btnSaveConfig').addEventListener('click', () => {
        currentConfig.host = document.getElementById('cfgHost').value.trim();
        currentConfig.port = parseInt(document.getElementById('cfgPort').value, 10) || 8084;
        currentConfig.path = document.getElementById('cfgPath').value.trim() || '/mqtt';
        currentConfig.username = document.getElementById('cfgUser').value.trim();
        currentConfig.password = document.getElementById('cfgPass').value.trim();
        currentConfig.topic = document.getElementById('cfgTopic').value.trim();
        currentConfig.clientIdPrefix = document.getElementById('cfgClientId').value.trim() || 'dashboard';

        try {
            localStorage.setItem('mqtt_iot_config', JSON.stringify(currentConfig));
        } catch (e) {}

        document.getElementById('metaHostText').innerText = currentConfig.host;
        document.getElementById('metaTopicText').innerText = currentConfig.topic;
        modalConfig.classList.remove('active');

        showToast('Đã lưu cấu hình. Đang kết nối lại...', 'success');
        connectMqtt();
    });

    // 12. Modal Mã nguồn Arduino ESP8266
    const modalCode = document.getElementById('modalCodeGuide');
    document.getElementById('btnOpenCodeGuide').addEventListener('click', () => {
        modalCode.classList.add('active');
    });

    document.getElementById('btnCloseCodeModal').addEventListener('click', () => {
        modalCode.classList.remove('active');
    });

    document.getElementById('btnCopyArduinoCode').addEventListener('click', () => {
        const code = document.getElementById('arduinoCodeSnippet').innerText;
        navigator.clipboard.writeText(code).then(() => {
            showToast('Đã sao chép mã nguồn ESP8266 Arduino!', 'success');
        });
    });

    // Đóng modal khi bấm ra ngoài nền xám
    window.addEventListener('click', (e) => {
        if (e.target === modalConfig) modalConfig.classList.remove('active');
        if (e.target === modalCode) modalCode.classList.remove('active');
    });
});
