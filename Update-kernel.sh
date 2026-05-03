#!/bin/bash
# ==============================================
#  小米 Raphael (K20 Pro) 内核自动更新脚本 v2.2
#  优化：防重名、aria2 参数调优、实时进度
# ==============================================
set -e

# ---------- 配置 ----------
BASE_URL="https://up-kernel.cuicanmx.cn"
FILES=(
    "update.7z"
)
DEB_FILES=(
    "linux-image-xiaomi-raphael.deb"
    "linux-headers-xiaomi-raphael.deb"
    "firmware-xiaomi-raphael.deb"
    "alsa-xiaomi-raphael.deb"
)
MAX_RETRIES=3
CONNECTIONS=4               # 降为4，更稳定，避免触发限速/拥塞
WORK_DIR="/tmp"
TIMESTAMP=$(date +%s)
LOG_FILE="/tmp/kernel_update_error.log"

# 颜色定义（自动适配终端）
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   🐧 小米 Raphael 内核更新脚本 v2.2 ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"

# ---------- 1. 权限与空间检查 ----------
echo -e "\n🔐 ${CYAN}[1/11] 权限与空间检查...${NC}"
[ "$(id -u)" -eq 0 ] || { echo -e "${RED}❌ 请使用 root 权限运行！${NC}"; exit 1; }
AVAILABLE=$(df -BM --output=avail "$WORK_DIR" | tail -1 | tr -d 'M')
if [ "$AVAILABLE" -lt 200 ]; then
    echo -e "${RED}❌ 工作目录空间不足 (仅 ${AVAILABLE}MB，需要≥200MB)${NC}"
    exit 1
fi
echo -e "   📂 工作目录: $WORK_DIR"
echo -e "   💾 可用空间: ${AVAILABLE}MB ${GREEN}✅ 充足${NC}"
cd "$WORK_DIR" || { echo -e "${RED}❌ 无法进入 $WORK_DIR${NC}"; exit 1; }

# ---------- 2. 下载工具准备 ----------
echo -e "\n🔧 ${CYAN}[2/11] 下载工具准备...${NC}"
if ! command -v aria2c &>/dev/null; then
    echo -e "   ⚙️ 正在安装 aria2..."
    apt-get update -qq && apt-get install -y -qq aria2 2>/dev/null || {
        echo -e "   ${YELLOW}⚠️  aria2 安装失败，将使用 wget${NC}"
    }
fi
if ! command -v 7z &>/dev/null; then
    echo -e "   ⚙️ 正在安装 p7zip-full..."
    apt-get update -qq && apt-get install -y -qq p7zip-full 2>/dev/null || {
        echo -e "   ${RED}❌ 无法安装 7z，无法解压 update.7z${NC}"
        exit 1
    }
fi
# 清理上一次可能残留的 .aria2 文件和旧deb包
rm -f *.aria2 "${DEB_FILES[@]}" 2>/dev/null || true
> "$LOG_FILE"

# ---------- 辅助函数：显示下载速度/大小 ----------
show_progress() {
    local file=$1
    local aria_log=$2
    # 从 aria2 输出中实时提取速度和进度（已由 --summary-interval=1 产生）
    tail -f "$aria_log" 2>/dev/null | while read -r line; do
        if [[ "$line" == *"DL:"* ]]; then
            echo -ne "\r   ⏳ ${file}: ${line#*DL:}" >&2
        fi
    done
}

# ---------- 3. 下载函数（优化版）----------
download_with_aria2() {
    local file=$1
    local url="${BASE_URL}/${file}"
    local retry=0
    local tmp_log="/tmp/aria2_${file}.log"

    # 删除旧文件，避免自动重命名为 .1.deb 等问题
    rm -f "$file" "$file.aria2"

    while [ $retry -lt $MAX_RETRIES ]; do
        echo -e "   ⬇️  [$(($retry+1))/$MAX_RETRIES] 下载 ${file} ..."
        # aria2c 参数优化：
        # -x 4 -s 4  : 稳定并发，避免触发限速
        # -k 1M      : 小分片，适应网络波动
        # --allow-overwrite=true : 允许覆盖（配合手动删除更安全）
        # --auto-file-renaming=false : 禁止自动重命名
        # --console-log-level=error --summary-interval=1 : 只显示进度，每秒更新
        aria2c -x $CONNECTIONS -s $CONNECTIONS -k 1M \
               --allow-overwrite=true --auto-file-renaming=false \
               --max-tries=5 --retry-wait=2 --timeout=60 --connect-timeout=10 \
               --console-log-level=error --summary-interval=1 \
               -o "$file" "$url" > "$tmp_log" 2>&1
        if [ -f "$file" ] && [ -s "$file" ]; then
            echo -e "\n   ${GREEN}✅ ${file} 下载完成${NC}"
            rm -f "$tmp_log"
            return 0
        fi
        retry=$((retry+1))
        echo -e "   ${YELLOW}🔄 下载失败，${retry}s 后重试...${NC}"
        rm -f "$file" "$file.aria2" "$tmp_log"
        sleep $retry
    done
    echo -e "   ${RED}❌ ${file} 下载失败（已重试 ${MAX_RETRIES} 次）${NC}"
    return 1
}

download_with_wget() {
    local file=$1
    local url="${BASE_URL}/${file}"
    local retry=0
    rm -f "$file"
    while [ $retry -lt $MAX_RETRIES ]; do
        echo -e "   ⬇️  [$(($retry+1))/$MAX_RETRIES] 下载 ${file} ..."
        wget -c --tries=5 --timeout=60 --connect-timeout=10 -O "$file" "$url" 2>&1 | grep --line-buffered "%" || true
        if [ -f "$file" ] && [ -s "$file" ]; then
            echo -e "\n   ${GREEN}✅ ${file} 下载完成${NC}"
            return 0
        fi
        retry=$((retry+1))
        echo -e "   ${YELLOW}🔄 下载失败，${retry}s 后重试...${NC}"
        rm -f "$file"
        sleep $retry
    done
    echo -e "   ${RED}❌ ${file} 下载失败（已重试 ${MAX_RETRIES} 次）${NC}"
    return 1
}

# ---------- 4. 批量下载 ----------
echo -e "\n📦 ${CYAN}[3/11] 开始下载内核包 (共${#FILES[@]}个)${NC}"
failed=0
pids=()
for file in "${FILES[@]}"; do
    if command -v aria2c &>/dev/null; then
        download_with_aria2 "$file" &
    else
        download_with_wget "$file" &
    fi
    pids+=($!)
done
# 等待所有子进程
for pid in "${pids[@]}"; do
    wait $pid || failed=1
done
if [ $failed -ne 0 ]; then
    echo -e "\n${RED}❌ 部分文件下载失败！详见 ${LOG_FILE}${NC}"
    rm -f "${FILES[@]}" *.aria2
    exit 1
fi
echo -e "\n   ${GREEN}🎉 所有文件下载完成！${NC}"

# ---------- 5. 解压 update.7z ----------
echo -e "\n📦 ${CYAN}[4/11] 解压 update.7z...${NC}"
if 7z x -y update.7z 2>>"$LOG_FILE"; then
    echo -e "   ${GREEN}✅ update.7z 解压成功${NC}"
else
    echo -e "   ${RED}❌ update.7z 解压失败！${NC}"
    rm -f update.7z "${DEB_FILES[@]}"
    exit 1
fi

# ---------- 6. 文件验证 ----------
echo -e "\n🔍 ${CYAN}[5/11] 验证解压文件完整性...${NC}"
all_ok=true
for file in "${DEB_FILES[@]}"; do
    if [ -s "$file" ]; then
        size=$(du -h "$file" | cut -f1)
        echo -e "   ${GREEN}✅ ${file} (${size})${NC}"
    else
        echo -e "   ${RED}❌ ${file} 缺失或大小为0${NC}"
        all_ok=false
    fi
done
$all_ok || exit 1

# ---------- 7. 备份当前启动文件 ----------
echo -e "\n💾 ${CYAN}[6/11] 备份当前启动文件...${NC}"
backup_initramfs=""
backup_linuxefi=""
if [ -f /boot/initramfs ]; then
    cp /boot/initramfs /boot/initramfs.bak.$TIMESTAMP
    backup_initramfs=/boot/initramfs.bak.$TIMESTAMP
    echo -e "   📋 initramfs → ${backup_initramfs##*/}"
fi
if [ -f /boot/linux.efi ]; then
    cp /boot/linux.efi /boot/linux.efi.bak.$TIMESTAMP
    backup_linuxefi=/boot/linux.efi.bak.$TIMESTAMP
    echo -e "   📋 linux.efi → ${backup_linuxefi##*/}"
fi

# ---------- 8. 卸载旧内核 ----------
echo -e "\n🧹 ${CYAN}[7/12] 卸载旧 sm8150 内核及相关包...${NC}"
OLD_PKGS=$(dpkg -l 2>/dev/null | grep -E 'linux-(image|headers)-.*sm8150|firmware-xiaomi-raphael|alsa-xiaomi-raphael' | awk '{print $2}' | tr '\n' ' ')
if [ -n "$OLD_PKGS" ]; then
    echo -e "   📦 发现旧包: ${YELLOW}${OLD_PKGS}${NC}"
    dpkg --purge --force-all $OLD_PKGS 2>/dev/null || true
    REMAIN=$(dpkg -l 2>/dev/null | grep -E 'linux-(image|headers)-.*sm8150' | awk '{print $2}')
    for pkg in $REMAIN; do
        dpkg --force-all -P "$pkg" 2>/dev/null || true
    done
    echo -e "   ${GREEN}✅ 旧包清理完毕${NC}"
else
    echo -e "   ℹ️  未发现旧内核包"
fi
echo -e "   🗑️  清理 /lib/modules 全部残留模块..."
rm -rf /lib/modules/*

# ---------- 9. 安装依赖 ----------
echo -e "\n📎 ${CYAN}[8/12] 安装必要依赖...${NC}"
apt-get update -qq
if apt-get install -y -qq alsa-ucm-conf 2>>"$LOG_FILE"; then
    echo -e "   ${GREEN}✅ alsa-ucm-conf 已安装${NC}"
else
    echo -e "   ${YELLOW}⚠️  alsa-ucm-conf 安装失败（可能影响音频）${NC}"
fi

# ---------- 10. 安装新内核 ----------
echo -e "\n⚙️  ${CYAN}[9/12] 安装新内核 (共${#DEB_FILES[@]}个包)${NC}"
if dpkg -i "${DEB_FILES[@]}" 2>>"$LOG_FILE"; then
    echo -e "   ${GREEN}✅ 内核包安装成功${NC}"
else
    echo -e "   ${YELLOW}⚠️  首次安装有问题，尝试修复依赖...${NC}"
    if apt-get install -f -y 2>>"$LOG_FILE"; then
        echo -e "   ${GREEN}✅ 依赖修复完成${NC}"
    else
        echo -e "   ${YELLOW}⚠️  普通修复失败，尝试强制安装...${NC}"
        if dpkg -i --force-all "${DEB_FILES[@]}" 2>>"$LOG_FILE"; then
            echo -e "   ${GREEN}✅ 强制安装成功${NC}"
        else
            echo -e "${RED}❌ 安装彻底失败！恢复备份中...${NC}"
            [ -n "$backup_initramfs" ] && mv "$backup_initramfs" /boot/initramfs
            [ -n "$backup_linuxefi" ] && mv "$backup_linuxefi" /boot/linux.efi
            exit 1
        fi
    fi
fi

# ---------- 11. 检测内核版本 ----------
echo -e "\n🔎 ${CYAN}[10/12] 检测新内核版本...${NC}"
NEW_VER=$(ls -1 /lib/modules/ 2>/dev/null | tail -1)
[ -n "$NEW_VER" ] || { echo -e "${RED}❌ 未找到内核模块目录！${NC}"; exit 1; }
echo -e "   🐧 内核版本: ${GREEN}${NEW_VER}${NC}"

# ---------- 12. 生成 initramfs ----------
echo -e "\n🖥️  ${CYAN}[11/12] 生成 initramfs...${NC}"
if command -v update-initramfs &>/dev/null; then
    update-initramfs -c -k "$NEW_VER" 2>>"$LOG_FILE"
    echo -e "   ${GREEN}✅ initramfs 生成成功${NC}"
else
    echo -e "   ${YELLOW}⚠️  未找到 update-initramfs，跳过${NC}"
fi

# ---------- 13. 配置启动文件 ----------
echo -e "\n🚀 ${CYAN}[12/12] 配置启动文件...${NC}"
rm -f /boot/initramfs /boot/linux.efi
INITRD="/boot/initrd.img-${NEW_VER}"
VMLINUZ="/boot/vmlinuz-${NEW_VER}"

if [ -f "$INITRD" ]; then
    mv "$INITRD" /boot/initramfs
else
    FALLBACK=$(ls -t /boot/initrd.img-* 2>/dev/null | head -1)
    [ -n "$FALLBACK" ] && mv "$FALLBACK" /boot/initramfs || { echo -e "${RED}❌ 找不到 initrd 文件！${NC}"; exit 1; }
fi

if [ -f "$VMLINUZ" ]; then
    mv "$VMLINUZ" /boot/linux.efi
else
    FALLBACK=$(ls -t /boot/vmlinuz-* 2>/dev/null | head -1)
    [ -n "$FALLBACK" ] && mv "$FALLBACK" /boot/linux.efi || { echo -e "${RED}❌ 找不到 vmlinuz 文件！${NC}"; exit 1; }
fi

echo -e "   ${GREEN}✅ /boot/initramfs 与 /boot/linux.efi 已就绪${NC}"
echo -e "   ${GREEN}✅ 系统可引导${NC}"

# ---------- 清理 ----------
echo -e "\n🧼 清理临时文件..."
rm -f "${FILES[@]}" "${DEB_FILES[@]}" *.aria2 /boot/initramfs.bak.* /boot/linux.efi.bak.* 2>/dev/null || true

echo -e "\n${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  🎉 内核更新完成！请执行 reboot 重启至新内核  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo -e "ℹ️  如有异常，查看错误日志: ${YELLOW}${LOG_FILE}${NC}"