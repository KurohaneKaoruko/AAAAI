/**
 * 沙箱执行超时常量。
 *
 * 单独放一个无依赖文件：customSandbox.ts（主线程）和 customSandboxWorker.js
 * （worker 线程，编译成 .js 后在 dist 里与 src 目录分离）都要用它，
 * 避免循环引用或打包路径问题。
 */

/** 单次策略执行超时（毫秒）。正常策略 <1ms，50ms 已是百倍冗余；死循环在此被掐断。 */
export const CUSTOM_EXEC_TIMEOUT_MS = 50;
