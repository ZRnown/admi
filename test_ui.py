"""
UI 测试脚本 - 验证重构后的前端功能
"""
import asyncio
from playwright.async_api import async_playwright

async def test_ui():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # 访问登录页面
        await page.goto('http://localhost:3002')
        await page.wait_for_load_state('networkidle')

        # 截图登录页面
        await page.screenshot(path='screenshot_login.png')
        print("✓ 登录页面截图已保存")

        # 检查登录页面元素
        login_title = await page.query_selector('h1')
        if login_title:
            title_text = await login_title.inner_text()
            print(f"✓ 登录页面标题: {title_text}")

        await browser.close()
        print("✓ 测试完成")

if __name__ == '__main__':
    asyncio.run(test_ui())
