import requests
import json

def send_simple_embed(webhook_url, code_content):
    # 构造 Discord Embed 载荷
    # 使用 f-string 将代码包裹在 Markdown 的三个反引号中
    payload = {
        "embeds": [
            {
                "title": "🎉 成功跑出靓号！",
                "description": f"以下是地址私钥信息，请妥善保存：\n\n```text\n{code_content}\n```",
                "color": 65280  # 绿色
            }
        ]
    }

    # 发送 POST 请求
    response = requests.post(
        webhook_url, 
        data=json.dumps(payload),
        headers={"Content-Type": "application/json"}
    )

    if response.status_code == 204:
        print("Webhook 发送成功")
    else:
        print(f"发送失败: {response.status_code}")

# 使用示例
YOUR_WEBHOOK_URL = "https://discord.com/api/webhooks/1453581926152671242/r3oszH65OypFIhj7c9m7n16_rGemG1VJ6oUS8MenoKCWdMW6itVLoP0aPlVB0iXvPi21"
# 这里可以放你从日志里抓取到的地址和私钥
sample_result = "Address: TXXXXX...\nPrivkey: 5XXXXX..." 

send_simple_embed(YOUR_WEBHOOK_URL, sample_result)