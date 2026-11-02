/**
 * 页面级错误边界。
 *
 * 以前任何页面在渲染期抛错都会让整棵树卸载，用户看到的是一整片白屏，
 * 连侧栏都没了，只能手动刷新。现在只坏当前页：侧栏、顶栏仍在，
 * 可以切到别的页面继续用；同时给出错误详情，方便反馈问题。
 *
 * 由 App 用 route key 包裹，切页会自动重置错误状态。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Panel } from "./ui";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份完整堆栈；界面只展示摘要，避免刷屏
    console.error("页面渲染异常:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <Panel title="这个页面出错了" subtitle="其他页面仍可正常使用">
          <p className="error-boundary-msg">{this.state.error.message || "未知错误"}</p>
          <details className="error-boundary-detail">
            <summary>查看错误详情</summary>
            <pre>{this.state.error.stack ?? String(this.state.error)}</pre>
          </details>
          <div className="btn-row">
            <Button variant="primary" onClick={() => this.setState({ error: null })}>
              重试
            </Button>
            <Button onClick={() => window.location.reload()}>刷新页面</Button>
          </div>
        </Panel>
      </div>
    );
  }
}
