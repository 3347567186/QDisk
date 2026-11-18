/* 滚动跟随：视角跟着最后一行走，读者一往上翻就撒手。
 *
 * 规则照参考实现抄的：贴底容差 25px；读者自己动了 >0.5px 才算「读者移动」；
 * 程序写入会同步基线，所以程序滚动不会被误判成读者移动；
 * 判定在 500ms 采样或 scrollend 时结算；读者滚回距底 <1px 当帧恢复跟随。
 */
(function (root) {
  'use strict';

  var THRESHOLD = 25;      // 距底多少 px 以内算贴底
  var EPS = 0.5;           // 小于这个位移当作没动（亚像素抖动）
  var SAMPLE_MS = 500;     // 无 scrollend 时的采样周期

  function create(opts) {
    var scroller = opts.scroller;
    var content = opts.content;
    var onChange = opts.onChange || function () {};
    var reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    var following = true;     // 是否跟着底
    var baseline = 0;         // 上一次已知的 scrollTop（含程序写入）
    var timer = null;
    var destroyed = false;

    function floor() {
      return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }

    function gap() {
      return floor() - scroller.scrollTop;
    }

    function writeTo(top, behavior) {
      if (behavior === 'smooth') {
        try { scroller.scrollTo({ top: top, behavior: 'smooth' }); return; }
        catch (e) { /* 老引擎不认 options，退回直设 */ }
      }
      scroller.scrollTop = top;
      baseline = top;
    }

    function toBottom(behavior) {
      writeTo(floor(), reduced ? 'instant' : (behavior || 'instant'));
    }

    function setFollowing(next, why) {
      if (following === next) return;
      following = next;
      scroller.setAttribute('data-following', next ? '1' : '');
      onChange({ following: next, why: why || '' });
    }

    /* 结算一次：读位置 → 判跟随 → 通知 */
    function settle(why) {
      var top = scroller.scrollTop;
      var f = floor();
      var moved = Math.abs(top - Math.min(baseline, f)) > EPS;
      baseline = top;

      if (following) {
        if (gap() > THRESHOLD) setFollowing(false, why);
      } else if (gap() < 1) {
        setFollowing(true, why);
      } else if (moved && gap() > THRESHOLD) {
        /* 已经在不跟随时继续往上翻，保持不跟随 */
        setFollowing(false, why);
      }
    }

    function schedule() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        settle('sample');
      }, SAMPLE_MS);
    }

    function onScroll() {
      if (destroyed) return;
      /* 读者滚回底部附近就当帧恢复，不等采样 */
      if (!following && gap() < 1) {
        setFollowing(true, 'bottom');
        baseline = scroller.scrollTop;
        return;
      }
      schedule();
    }

    function onScrollEnd() {
      if (destroyed) return;
      if (timer) { clearTimeout(timer); timer = null; }
      settle('scrollend');
    }

    /* 内容变高（Markdown 渲染、折叠展开、图片加载）→ 跟着底就重新贴底 */
    var ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(function () {
        if (destroyed) return;
        if (following) toBottom('instant');
        else onChange({ following: false, why: 'resize' });
      })
      : null;
    if (ro) {
      ro.observe(content);
      ro.observe(scroller);
    }

    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', onScrollEnd);

    return {
      isFollowing: function () { return following; },
      /* 程序滚动：跳转、恢复阅读位置都走这里，先撒手再写 */
      pause: function (why) { setFollowing(false, why || 'jump'); },
      resume: function () { setFollowing(true, 'resume'); toBottom('instant'); },
      toBottom: toBottom,
      /* 让某个节点对齐到视口顶部下方 offset 处（跳转用） */
      reveal: function (node, offset) {
        if (!node) return;
        setFollowing(false, 'reveal');
        var top = node.offsetTop - (offset == null ? 24 : offset);
        writeTo(Math.max(0, Math.min(top, floor())), 'instant');
        onChange({ following: false, why: 'reveal' });
      },
      destroy: function () {
        destroyed = true;
        if (timer) clearTimeout(timer);
        if (ro) ro.disconnect();
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('scrollend', onScrollEnd);
      }
    };
  }

  root.AIFollow = { create: create, THRESHOLD: THRESHOLD };
  if (typeof module === 'object' && module.exports) module.exports = root.AIFollow;
})(typeof self !== 'undefined' ? self : this);
