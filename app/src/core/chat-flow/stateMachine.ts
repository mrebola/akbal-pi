import { ChatFlowContext, FlowName, FlowStateHandler } from "./types";

export class FlowStateMachine {
  private states: Record<FlowName, FlowStateHandler>;
  private ctx: ChatFlowContext;

  constructor(ctx: ChatFlowContext, states: Record<FlowName, FlowStateHandler>) {
    this.ctx = ctx;
    this.states = states;
  }

  transitionTo(flowName: FlowName): void {
    this.ctx.currentFlowName = flowName;
    this.states[flowName](this.ctx);
  }
}
