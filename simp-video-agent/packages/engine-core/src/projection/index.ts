/**
 * Projection 层 —— State Read API 的全部实现（规范 §13 P3）。
 *
 * 这一层是【纯投影】：输入 Scene Doc，输出各种视图，不持有任何状态、不写文档。
 * 因此它天然满足"读到的永远是当前真相"，也天然不可能成为第二条写路径。
 *
 * 十一个接口，对应关系如下：
 *   get_scene_summary()      → getSceneSummary      默认入口，硬预算见 DEFAULT_SUMMARY_TOKEN_BUDGET
 *   get_object(id, detail?)  → getObject            只返回该对象及其效果
 *   list_objects(...)        → listObjects
 *   get_timeline(...)        → getTimeline
 *   get_effect(id)           → getEffect
 *   get_camera(range?)       → getCamera
 *   get_markers()            → getMarkers
 *   get_render_state(t)      → getRenderState       （需要 evaluate 产出 RenderState）
 *   get_diff(from, to)       → getDiff / diffDocs
 *   get_lock_details(paths)  → getLockDetails       只在准备 request_patch 时调
 *
 * 刻意【没有】get_locks()：锁路径已在 summary 里。
 */
export * from './tokens';
export * from './summary';
export * from './objects';
export * from './timeline';
export * from './render-state';
export * from './diff';
export * from './locks';
export * from './field-state';
