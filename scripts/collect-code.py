#!/usr/bin/env python3
"""
代码收集脚本
将项目中的所有有效代码文件收集到一个txt文件中
"""

import os
import sys
from pathlib import Path

# 要收集的文件扩展名
EXTENSIONS = {
    '.py', '.ts', '.tsx', '.js', '.jsx',
    '.json', '.md', '.txt', '.yml', '.yaml',
    '.sh', '.bash', '.css', '.scss', '.html'
}

# 要排除的目录
EXCLUDE_DIRS = {
    'node_modules', 'venv', 'ui', '.git',
    'dist', 'dist-bot', 'build', '__pycache__',
    '.next', '.cache', 'logs', '.data',
    'coverage', 'tmp', 'temp'
}

# 要排除的文件
EXCLUDE_FILES = {
    'package-lock.json', 'pnpm-lock.yaml',
    'yarn.lock', '.DS_Store'
}

def should_exclude_path(path: Path, root: Path) -> bool:
    """检查路径是否应该被排除"""
    # 检查路径中是否包含排除的目录
    parts = path.relative_to(root).parts
    for part in parts:
        if part in EXCLUDE_DIRS:
            return True

    # 检查文件名是否在排除列表中
    if path.name in EXCLUDE_FILES:
        return True

    return False

def collect_code_files(root_dir: str, output_file: str):
    """收集所有代码文件到输出文件"""
    root = Path(root_dir).resolve()
    output = Path(output_file).resolve()

    print(f"正在扫描目录: {root}")
    print(f"输出文件: {output}")
    print(f"排除目录: {', '.join(EXCLUDE_DIRS)}")
    print("-" * 60)

    collected_files = []

    # 遍历所有文件
    for file_path in root.rglob('*'):
        # 跳过目录
        if file_path.is_dir():
            continue

        # 跳过输出文件本身
        if file_path == output:
            continue

        # 检查是否应该排除
        if should_exclude_path(file_path, root):
            continue

        # 检查文件扩展名
        if file_path.suffix not in EXTENSIONS:
            continue

        collected_files.append(file_path)

    print(f"找到 {len(collected_files)} 个文件")
    print("-" * 60)

    # 写入输出文件
    with open(output, 'w', encoding='utf-8') as f:
        f.write(f"代码收集 - {root.name}\n")
        f.write(f"总文件数: {len(collected_files)}\n")
        f.write("=" * 80 + "\n\n")

        for i, file_path in enumerate(sorted(collected_files), 1):
            rel_path = file_path.relative_to(root)
            print(f"[{i}/{len(collected_files)}] {rel_path}")

            f.write("\n" + "=" * 80 + "\n")
            f.write(f"文件: {rel_path}\n")
            f.write("=" * 80 + "\n\n")

            try:
                content = file_path.read_text(encoding='utf-8')
                f.write(content)
                f.write("\n\n")
            except Exception as e:
                f.write(f"[错误: 无法读取文件 - {e}]\n\n")
                print(f"  ⚠️  无法读取: {e}")

    print("-" * 60)
    print(f"✅ 完成！代码已保存到: {output}")
    print(f"📊 总共收集了 {len(collected_files)} 个文件")

if __name__ == '__main__':
    # 默认参数
    root_dir = os.getcwd()
    output_file = 'collected_code.txt'

    # 解析命令行参数
    if len(sys.argv) > 1:
        root_dir = sys.argv[1]
    if len(sys.argv) > 2:
        output_file = sys.argv[2]

    collect_code_files(root_dir, output_file)
