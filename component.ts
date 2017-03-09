export type HookName = "afterrender" | "build" | "update" | "show" | "hide" | "beforereset" | "afterreset" | "state" | "reset";
export type ComponentHook = <ST>(dom: JQuery, st: ST) => Promise<any>;
export type Orientation = "horizontal" | "vertical";
export type Position = "top" | "right" | "bottom" | "left";
export const gns = "iwalp-games";
type StateTOKeyAsHooks<ST> = {
[K in keyof ST]: {(dom: JQuery, currentState: ST, previousState: ST): Promise<any> | void}[];

}
type PartialState< ST > = {
[K in keyof ST]?: ST[K] | {(p: ST): ST[K]};
}
type PartialUpdate<ST> = {
[K in keyof ST]?: Function;
}
type HOOKS<ST> = {
	"afterrender": {(dom: JQuery, st: ST): Promise<any> | void}[],
	"build": {(dom: JQuery, st: ST): Promise<any> | void}[],
	"update": {(dom: JQuery, currentState: ST, previousState: ST): PartialUpdate<ST>}[],
	"show": {(dom: JQuery, currentState: ST, previousState: ST): Promise<any> | void}[],
	"hide": {(dom: JQuery, currentState: ST, previousState: ST): Promise<any> | void}[],
	"afterreset": {(dom: JQuery, currentState: ST, previousState: ST): Promise<any> | void}[],
	"beforereset": {(dom: JQuery, currentState: ST, previousState: ST): Promise<any> | void}[],
	"reset": {(dom: JQuery, currentState: ST): Promise<any> | void}[],
};
/*
 * Return a resolved promise after the next browser re-flow
 * This is so dom manipulation that required knowledge about the client
 * calculations can use that information before running
 */
export function waitReflow(dom: HTMLElement) {
	return new Promise((s) => {
		setTimeout(() => {
			requestAnimationFrame(() => {
				window.getComputedStyle(dom).cssText;
				requestAnimationFrame(() => {
					s(dom)
				});
			});
		}, 0);
	})
}
class ComponentInternals<ST, OPTS> {
	attachment = new WeakMap<Component<ST, OPTS>, Component<ST, OPTS>[]>();
	discovered = new WeakMap<Component<ST, OPTS>, boolean>();
}

const internal = new ComponentInternals();
const componenthooks = Symbol("hook");
const componentbuildfn = Symbol("build");
const componentresetupdate = Symbol("forceupdate")
export abstract class Component<ST, OPTS> {
	state: ST;
	options: OPTS;
	slot: JQuery;
	dom: JQuery;
	hooks: HOOKS<ST>;
	constructor(slot?: JQuery, options?: OPTS) {
		this.slot = slot;
		this.options = options;
		this.state = <ST> this.defaults();
		this.hooks = {
			afterrender: [],
			build: [],
			update: [],
			show: [],
			hide: [],
			afterreset: [],
			beforereset: [],
			reset: [],
		}
		internal.discovered.set(this, false);
		internal.attachment.set(this, []);
		this.dom = undefined;
	}
	append(components: Component<ST, OPTS>[], withRender?: boolean) {
		let at = internal.attachment.get(this);
		for (let c of components) {
			if (c.slot === undefined) {
				c.slot = this.slot;
			}
			at.push(c);
			if (withRender) {
				c.render();
			} else {
				this.onRendered(() => c.render())
			}
		}
		return this.slot;
	}
	on<H>(hookName: HookName, hook: H) {
		let hs: H[] = this.hooks[hookName]
		hs.push(hook);
	}
	abstract defaults(): ST;
	onBuild(hook: (st: ST) => JQuery | void) {
		this.on("build", hook);
	}
	onRendered(hook: (dom: JQuery, st: ST) => Promise<any> | void) {
		this.on("afterrender", hook);
	}
	onUpdate(hook: (dom: JQuery, currentState: ST, previousState: ST) => PartialUpdate<ST>) {
		this.on("update", hook);
	}
	onDiscovered(hook: (dom: JQuery, st: ST) => Promise<any>) {
		this.on("show", hook);
	}
	onConceal(hook: (dom: JQuery, st: ST) => Promise<any>) {
		this.on("hide", hook);
	}
	onReset(hook: (dom: JQuery, currentState: ST) => Promise<any> | void) {
		this.on("reset", hook);
	}
	[componentbuildfn](): Promise<JQuery | void> {
		let k = this.runHooks<JQuery, [ST]>("build", [this.state],
			((x) => new Promise((s) => {
				if (this.dom === undefined) {
					this.dom = x;
				}
				s(x);
			}
			)), ((x: JQuery) => {
				if (x === undefined) {
					x = this.dom;
				}
				return Promise.resolve(x.promise());
			})); // Transform the JQuery Object into a promise here
		return k;
	}
	[componentresetupdate](): Promise<ST> {
		let state = this.defaults();
		let updates = this.hooks.update;
		let p: Promise<any> = Promise.resolve();
		this.state = <ST> state;
		for (let u of updates) {
			const map = u(this.dom, this.state, this.state);
			if (Reflect.has(map, "before") && $.isFunction(map["before"]) && map["before"]() === false) {
				return p.then(() => this.state);
			}
			const acc = [];
			p = p.then(() => Promise.all(Object.keys(state).map((c) => {
				return Reflect.has(map, c)
					&& (c !== <string> "before" || c !== <string> "after")
					&& $.isFunction(map[c]) &&
					map[c](this.state[c]);
			})));
			if (Reflect.has(map, "after") && $.isFunction(map["after"])) {
				p = p.then(() => map["after"]());
			}
		}
		return p.then(() => this.state);
	}
	reset() {
		return this[componentresetupdate]()
			.then(_ => this.runHooks("reset", [this.dom, this.state]));
	}
	/*
	 * Execute a the hooks attached to the `update` given a object which  partially map the
	 * component state
	 * @param void:
	 * @returns Promise<{[keyof state]: v}>
	 */
	update(state: PartialState<ST>): Promise<ST> {
		const previous = Object.assign({}, this.state);
		let changed = [];
		for (let k of Object.keys(state)) {
			let prop = Reflect.get(state, k);
			if ($.isFunction(prop)) {
				this.state[k] = prop(previous);
			} else {
				this.state[k] = prop;
			}
			if (previous[k] !== this.state[k]) {
				changed.push(k);
			}
		}
		/*
		 * Will update only on those keys which values were changed
		 */
		let updates = this.hooks.update;
		let p: Promise<any> = Promise.resolve();
		for (let u of updates) {
			const map = u(this.dom, this.state, previous);
			let acc = [];
			if (Reflect.has(map, "before") && $.isFunction(map["before"]) && map["before"]() === false) {
				return p.then(() => this.state);
			}
			p = p.then(() => Promise.all(changed.map((c) => {
				if (Reflect.has(map, c) && $.isFunction(map[c])) {
					let updated = map[c](this.state[c]);
					if (updated instanceof jQuery && updated.length) {
						return waitReflow(updated[0]);
					}
					return updated;
				}
			})));
			if (Reflect.has(map, "after") && $.isFunction(map["after"])) {
				p = p.then(() => map["after"]());
			}
		}
		return p.then(() => this.state);
	}
	discover(): Promise<any> {
		let k: Promise<any> = Promise.resolve();
		if (!internal.discovered.get(this)) {
			k = k
				.then(() => this.dom.css({visibility: "visible"}).promise())
				.then(() => this.runHooks("show", [this.dom, this.state]))
				.then(() => internal.discovered.set(this, true));
		}
		return k;
	};
	conceal(): Promise<any> {
		let k: Promise<any> = Promise.resolve();
		if (internal.discovered.get(this)) {
			k = k
				.then(() => this.dom.css({visibility: "hidden"}).promise())
				.then(_ => this.runHooks("hide", [this.dom, this.state]))
				.then(() => internal.discovered.set(this, false));
		}
		return k;
	}
	discovered() {
		return internal.discovered.get(this);
	}
	render(): Promise<JQuery> {
		return Promise.resolve().then(() => this[componentbuildfn]())
			.then(_ => this.slot.append(this.dom).promise()).then(() => {
				/*
				 * This force the browser to make calculations so dom data
				 * like `width` and `height` are available after rendering
				 */
				return waitReflow(this.slot[0]).then(() => {
					/*
					* All rendering must be finished before updating
					* anything else.
					* the afterrender hook could have rendering queues,
					* so they must be finished before updating the dom
					*/
					let k: Promise<any> = Promise.resolve();
					let cs = internal.attachment.get(this);
					if (cs.length > 0) {
						for (let c of cs) {
							k = k.then(() => c.render());
						}
					}
					return k
						.then(() => this.runHooks("afterrender", [this.dom, this.state]))
						.then(() => this[componentresetupdate]())

				});
			});
	}
	rerender() {
		this.unrender()
			.then(_ => this.state = <ST> this.defaults())
			.then(_ => this.render());
	}
	unrender(): Promise<void> {
		return Promise.resolve(this.dom.remove().promise())
	}
	destroy(): Promise<ST> {
		return this.unrender().then(_ => this.reset());
	}
	/*
	 * Will run all function in a hook slot sequentially
	 * the handler function is to handle hooks which don't return a Promise like object
	 * the afterHook function is to make an action after the hook was run
	 */
	runHooks<T, ARGS>(hookName: HookName, args: ARGS, afterHook?: (x: T) => Promise<T>, handler?: (x: T) => Promise<T>) {
		let buildHooks: ((args: ARGS) => T)[] = this.hooks[hookName];
		if (buildHooks.length > 0) {
			return buildHooks.reduce((acc, h) => {
				return acc.then(() => {
					let j = h.apply(this, args);
					if (handler !== undefined) {
						j = handler(j);
					}
					let r: Promise<any> = j;
					if (!(r instanceof Promise)) {
						r = new Promise((s) => {
							s({
								value: j,
								args: args
							});
						});
					} else {
						r = r.then((x: T) => {
							return {
								value: x,
								args: args
							}
						});
					}
					return r.then((x: {value: T, args: ARGS}) => {
						if ($.isFunction(afterHook)) {
							return afterHook(x.value)
						}
						return r;
					})
				});

			}, Promise.resolve())
		}
		return Promise.resolve();
	}
}