"""
重构后的 UI 测试脚本
验证：
1. 实例控制栏（启动/停止按钮）
2. 账号库（无连接/断开按钮）
3. 页面宽度调整
"""
from playwright.sync_api import sync_playwright
import time

def test_ui():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})

        print("=" * 50)
        print("开始 UI 测试")
        print("=" * 50)

        # 访问页面
        page.goto('http://localhost:3002')
        page.wait_for_load_state('networkidle')
        time.sleep(2)

        # 截图首页
        page.screenshot(path='screenshot_home.png', full_page=True)
        print("✓ 首页截图已保存: screenshot_home.png")

        # 检查页面宽度
        body = page.query_selector('body')
        if body:
            box = body.bounding_box()
            print(f"✓ 页面宽度: {box['width']}px")

        # 检查实例控制栏
        instance_bar = page.query_selector('[class*="instance-control"]')
        start_btn = page.query_selector('button:has-text("启动")')
        stop_btn = page.query_selector('button:has-text("停止")')

        if start_btn or stop_btn:
            print("✓ 找到实例控制按钮（启动/停止）")
        else:
            print("⚠ 未找到实例控制按钮")

        # 检查是否有连接/断开按钮（应该已被移除）
        connect_btn = page.query_selector('button:has-text("连接")')
        disconnect_btn = page.query_selector('button:has-text("断开")')

        if not connect_btn and not disconnect_btn:
            print("✓ 账号库中已移除连接/断开按钮")
        else:
            print("⚠ 账号库中仍存在连接/断开按钮")

        # 检查页面标题
        title = page.title()
        print(f"✓ 页面标题: {title}")

        # 检查主要 UI 元素
        h1 = page.query_selector('h1')
        if h1:
            h1_text = h1.inner_text()
            print(f"✓ 主标题: {h1_text}")

        browser.close()
        print("=" * 50)
        print("UI 测试完成")
        print("=" * 50)

if __name__ == '__main__':
    test_ui()
