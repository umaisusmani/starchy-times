#!/usr/bin/env python3
"""Starchy Times launcher: a bare GTK window around the local server.

Deliberately tiny (no pywebview): less RAM, and it restarts the server or the page
if either one dies, so a crash does not leave a dead window.
"""
import os
import signal
import socket
import subprocess
import sys
import time

# Software compositing: noticeably less RAM for a mostly-static page. Set POMO_GPU=1 to opt out.
if not os.environ.get('POMO_GPU'):
    os.environ.setdefault('WEBKIT_DISABLE_COMPOSITING_MODE', '1')

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('WebKit2', '4.0')
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('POMO_PORT') or 9876)
URL = os.environ.get('POMO_URL') or f'http://127.0.0.1:{PORT}/'

server = None
stopping = False


def start_server():
    global server
    server = subprocess.Popen(
        ['node', '--max-old-space-size=48', os.path.join(HERE, 'server.js')],
        cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def wait_for_port(timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            socket.create_connection(('127.0.0.1', PORT), timeout=0.3).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def watchdog():
    if not stopping and server is not None and server.poll() is not None:
        start_server()
    return True


def stop_server():
    global stopping
    stopping = True
    if server and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()


def quit_all(*_):
    stop_server()
    Gtk.main_quit()
    return False


def build_window():
    ctx = WebKit2.WebContext.new_ephemeral()
    ctx.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)

    settings = WebKit2.Settings()
    for name, value in (
        ('enable_page_cache', False),
        ('enable_webgl', False),
        ('enable_media_stream', False),
        ('enable_developer_extras', False),
        ('enable_smooth_scrolling', False),
        ('enable_write_console_messages_to_stdout', False),
        ('media_playback_requires_user_gesture', False),
    ):
        setter = getattr(settings, 'set_' + name, None)
        if setter:
            setter(value)
    if not os.environ.get('POMO_GPU'):
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)

    view = WebKit2.WebView.new_with_context(ctx)
    view.set_settings(settings)
    bg = Gdk.RGBA()
    bg.parse('#d3caaf')
    view.set_background_color(bg)
    view.connect('web-process-terminated', lambda v, reason: v.reload())

    win = Gtk.Window(title='Starchy Times')
    win.set_default_size(1100, 720)
    win.add(view)
    win.connect('destroy', quit_all)
    win.show_all()
    view.load_uri(URL)
    return win


if __name__ == '__main__':
    if not os.environ.get('POMO_URL'):
        start_server()
        wait_for_port()
        GLib.timeout_add_seconds(2, watchdog)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, quit_all)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, quit_all)
    build_window()
    try:
        Gtk.main()
    finally:
        stop_server()
        sys.exit(0)
