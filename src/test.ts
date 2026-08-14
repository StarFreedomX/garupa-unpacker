import axios from 'axios';

/**
 * 目标配置
 */
const TARGET_URL = 'https://content.garupa.jp/Release/9.4.0.170_9b65fe761fdb81f51e8120fd5d1c90b0961c3b8845e1430a77c268a66f1e4015/Android/sound/voice_stamp';
const CHECK_INTERVAL_MS = 5000; // 每 5 秒检查一次

/**
 * 满足条件后执行的函数
 */
function onTargetConditionMet(): void {
    console.log('🎉 成功检测到非 403 响应，正在执行后续任务...');
    const messages = [
        {
            "type": "at",
            "data": {
                "qq": "2958467364"
            }
        },
        {
            "type": "text",
            "data": {
                "text": ` 1111111`
            }
        }
    ]
    const groups = ["964241442"]
    const datas = groups.map(group => ({
        "group_id": group,
        "message": messages,
    }))
    // datas.map(data=>axios.post("http://10.66.66.1:3000/send_group_msg", data))
}

/**
 * 核心轮询逻辑
 */
const timer = setInterval(async () => {
    try {
        console.log(`正在请求: ${TARGET_URL}...`);
        const response = await axios.get(TARGET_URL);

        // 如果请求成功（通常是 200），说明不是 403
        console.log(`收到响应: ${response.status}`);
        executeAndStop();

    } catch (error: any) {
        if (error.response) {
            // 服务器返回了错误状态码
            if (error.response.status === 403) {
                console.log('结果仍为 403，继续等待...');
            } else {
                // 返回了其他错误码（如 404, 500 等），按要求也应视为“非 403”
                console.log(`收到非 403 错误码: ${error.response.status}`);
                executeAndStop();
            }
        } else {
            // 网络错误或请求未发出
            console.error('网络请求失败:', error.message);
        }
    }
}, CHECK_INTERVAL_MS);

/**
 * 执行函数并终止循环
 */
function executeAndStop() {
    onTargetConditionMet();
    clearInterval(timer);
    console.log('🛑 已停止定时任务。');
}