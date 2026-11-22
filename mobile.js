// VibePhi 移动端触控适配：禁双击缩放、长按画布默认菜单；桌面环境零影响。
(function () {
    'use strict';
    var isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
        || 'ontouchstart' in window;
    if (!isTouch) return;
    document.documentElement.classList.add('is-touch');
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        (document.head || document.documentElement).append(meta);
    }
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    // 长按画布时屏蔽系统默认行为（文本选择/放大镜），编辑器的自定义右键菜单仍可触发
    document.addEventListener('contextmenu', function (e) {
        if (e.target && e.target.closest && e.target.closest('canvas')) e.preventDefault();
    }, true);
})();
