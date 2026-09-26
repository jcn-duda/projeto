// htm@3.1.1/preact/standalone.module.js
// sha256: 72284e8e9079c87817145df1110f74e8a2aa040b2fc384922e18dfcb46fc1fd7

export type VNode<P = any> = {
  type: any;
  props: P & { children?: any };
  key: any;
  ref: any;
  __k?: any;
};

export interface ComponentChild {
  [key: string]: any;
}

export type ComponentChildren = ComponentChild[] | ComponentChild | string | number | boolean | null | undefined;

export interface FunctionComponent<P = {}> {
  (props: P, context?: any): VNode<any> | null;
  displayName?: string;
  defaultProps?: Partial<P>;
}

export interface AnyComponent<P = {}> {
  (props: P, context?: any): VNode<any> | null;
}

export interface RefObject<T> {
  current: T | null;
}

export declare function html(strings: TemplateStringsArray, ...values: any[]): any;

export declare function render(vnode: any, parent: Element | Document | ShadowRoot | DocumentFragment): void;

export declare function h(type: any, props?: any, ...children: any[]): VNode<any>;

export declare function useState<T>(initialState: T | (() => T)): [T, (value: T | ((prevState: T) => T)) => void];

export declare function useEffect(effect: () => void | (() => void), inputs?: any[]): void;

export declare function useLayoutEffect(effect: () => void | (() => void), inputs?: any[]): void;

export declare function useMemo<T>(factory: () => T, inputs: any[] | undefined): T;

export declare function useCallback<T extends Function>(callback: T, inputs: any[]): T;

export declare function useRef<T>(initialValue?: T): RefObject<T>;

export declare function useContext<T>(context: any): T;

export declare function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
  init?: (arg: any) => S
): [S, (action: A) => void];

export declare function createContext<T>(defaultValue: T): any;
