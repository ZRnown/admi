#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 功能测试脚本
用于测试 RapidOCR 服务是否正常工作
"""

import requests
import base64
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont
import time

def create_test_image(text="测试图片\nTest Image\n包含敏感信息", width=400, height=200):
    """创建测试图片"""
    # 创建白色背景图片
    img = Image.new('RGB', (width, height), color='white')
    draw = ImageDraw.Draw(img)

    # 尝试加载字体，如果失败使用默认字体
    try:
        # macOS 系统字体
        font = ImageFont.truetype('/System/Library/Fonts/Arial.ttf', 20)
    except:
        try:
            # Linux 系统字体
            font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
        except:
            # 使用默认字体
            font = ImageFont.load_default()

    # 在图片上绘制文字
    lines = text.split('\n')
    y = 20
    for line in lines:
        draw.text((20, y), line, fill='black', font=font)
        y += 30

    return img

def test_ocr_service(server_url="http://localhost:9003"):
    """测试 OCR 服务"""
    print(f"正在测试 OCR 服务: {server_url}")

    # 创建测试图片
    test_texts = [
        "这是一个正常的图片",
        "包含敏感信息\n禁止转发",
        "广告推广信息\n请勿传播",
        "Hello World\n正常英文内容"
    ]

    for i, text in enumerate(test_texts):
        print(f"\n--- 测试图片 {i+1} ---")
        print(f"图片内容: {text}")

        # 创建图片
        img = create_test_image(text)

        # 保存到内存缓冲区
        buffer = BytesIO()
        img.save(buffer, format='JPEG')
        buffer.seek(0)

        # 发送到 OCR 服务
        files = {'image': ('test.jpg', buffer, 'image/jpeg')}

        try:
            start_time = time.time()
            response = requests.post(f"{server_url}/ocr", files=files, timeout=30)
            end_time = time.time()

            print(f"请求耗时: {end_time - start_time:.2f}秒")
            print(f"响应状态码: {response.status_code}")

            if response.status_code == 200:
                result = response.json()
                print(f"OCR 结果: code={result.get('code', 'unknown')}")

                if result.get('code') == 0 and result.get('data'):
                    detected_text = []
                    for item in result['data']:
                        detected_text.append(item.get('text', ''))

                    all_text = ' '.join(detected_text)
                    print(f"识别出的文字: {all_text}")

                    # 检查关键词匹配
                    blocked_keywords = ["敏感信息", "禁止转发", "广告", "推广"]
                    matched = []
                    for keyword in blocked_keywords:
                        if keyword.lower() in all_text.lower():
                            matched.append(keyword)

                    if matched:
                        print(f"⚠️  匹配到屏蔽关键词: {', '.join(matched)}")
                        print("✅ 该图片会被过滤掉")
                    else:
                        print("✅ 未匹配到屏蔽关键词，该图片会正常转发")
                else:
                    print(f"❌ OCR 识别失败: {result}")
            else:
                print(f"❌ HTTP 错误: {response.text}")

        except requests.exceptions.RequestException as e:
            print(f"❌ 网络错误: {e}")
        except Exception as e:
            print(f"❌ 其他错误: {e}")

def main():
    print("=== Discord Bot OCR 功能测试 ===\n")

    server_url = input("请输入 OCR 服务地址 (默认: http://localhost:9003): ").strip()
    if not server_url:
        server_url = "http://localhost:9003"

    if not server_url.startswith('http'):
        server_url = f"http://{server_url}"

    test_ocr_service(server_url)

    print("\n=== 测试完成 ===")
    print("如果测试成功，您可以在 Discord Bot 配置中启用 OCR 功能了。")

if __name__ == "__main__":
    main()
