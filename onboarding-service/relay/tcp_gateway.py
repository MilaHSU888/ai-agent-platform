"""
WorkHub 工具入口轉接（階段 D）。

工具容器放在沒有對外路由的隔離網路，Docker 無法替它開放本機埠。這個小程式跑在平台自己的容器裡：
一邊接 127.0.0.1 的本機埠（給 Mac 瀏覽器），一邊接工具的隔離網路，只做 TCP 轉送（支援 WebSocket）。
不解析、不記錄傳輸內容。用法：python tcp_gateway.py <目標主機> <目標埠> [監聽埠=8000]
"""
import asyncio
import sys

TARGET, TPORT = sys.argv[1], int(sys.argv[2])
LISTEN = int(sys.argv[3]) if len(sys.argv) > 3 else 8000


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(client_r, client_w):
    try:
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(TARGET, TPORT), timeout=5)
    except (OSError, asyncio.TimeoutError):
        client_w.close()  # 工具還沒啟動或已停止：直接斷線，健康檢查會判定失敗
        return
    await asyncio.gather(pipe(client_r, up_w), pipe(up_r, client_w))


async def main():
    server = await asyncio.start_server(handle, '0.0.0.0', LISTEN)
    print(f'gateway :{LISTEN} -> {TARGET}:{TPORT}', flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
