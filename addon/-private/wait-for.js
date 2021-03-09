import { assert } from "@ember/debug";
import { schedule, cancel } from "@ember/runloop";
import { get } from "@ember/object";
import { addObserver, removeObserver } from '@ember/object/observers';
import { EmberYieldable, isEventedObject } from './utils';

class WaitForQueueYieldable extends EmberYieldable {
  constructor(queueName) {
    super();
    this.queueName = queueName;
    this.timerId = null;
  }

  onYield() {
    try {
      this.timerId = schedule(this.queueName, () => this.next());
    } catch(error) {
      this.throw(error);
    }
  }

  onDispose() {
    cancel(this.timerId);
    this.timerId = null;
  }
}

class WaitForEventYieldable extends EmberYieldable {
  constructor(object, eventName) {
    super();
    this.object = object;
    this.eventName = eventName;
    this.fn = null;
    this.didFinish = false;
    this.usesDOMEvents = false;
    this.requiresCleanup = false;
  }

  onYield() {
    this.fn = (event) => {
      this.didFinish = true;
      this.onDispose();
      this.next(event);
    };

    if (typeof this.object.addEventListener === "function") {
      // assume that we're dealing with a DOM `EventTarget`.
      this.usesDOMEvents = true;
      this.object.addEventListener(this.eventName, this.fn);
    } else if (typeof this.object.one === 'function') {
      // assume that we're dealing with either `Ember.Evented` or a compatible
      // interface, like jQuery.
      this.object.one(this.eventName, this.fn);
    } else {
      this.requiresCleanup = true;
      this.object.on(this.eventName, this.fn);
    }
  }

  onDispose() {
    if (this.fn) {
      if (this.usesDOMEvents) {
        // unfortunately this is required, because IE 11 does not support the
        // `once` option: https://caniuse.com/#feat=once-event-listener
        this.object.removeEventListener(this.eventName, this.fn);
      } else if (!this.didFinish || this.requiresCleanup) {
        this.object.off(this.eventName, this.fn);
      }

      this.fn = null;
    }
    this.object = null;
  }
}

class WaitForPropertyYieldable extends EmberYieldable {
  constructor(object, key, predicateCallback = Boolean) {
    super();
    this.object = object;
    this.key = key;

    if (typeof predicateCallback === "function") {
      this.predicateCallback = predicateCallback;
    } else {
      this.predicateCallback = v => v === predicateCallback;
    }

    this.observerBound = false;
  }

  onYield() {
    this.observerFn = () => {
      let value = get(this.object, this.key);
      let predicateValue = this.predicateCallback(value);
      if (predicateValue) {
        this.next(value);
        return true;
      }
    };

    if (!this.observerFn()) {
      addObserver(this.object, this.key, null, this.observerFn);
      this.observerBound = true;
    }
  }

  onDispose() {
    if (this.observerBound && this.observerFn) {
      removeObserver(this.object, this.key, null, this.observerFn);
      this.observerFn = null;
    }
    this.object = null;
  }
}

/**
 * Use `waitForQueue` to pause the task until a certain run loop queue is reached.
 *
 * ```js
 * import { task, waitForQueue } from 'ember-concurrency';
 * export default class MyComponent extends Component {
 *   &#64;task *myTask() {
 *     yield waitForQueue('afterRender');
 *     console.log("now we're in the afterRender queue");
 *   }
 * }
 * ```
 *
 * @param {string} queueName the name of the Ember run loop queue
 */
export function waitForQueue(queueName) {
  return new WaitForQueueYieldable(queueName);
}

/**
 * Use `waitForEvent` to pause the task until an event is fired. The event
 * can either be a jQuery event or an Ember.Evented event (or any event system
 * where the object supports `.on()` `.one()` and `.off()`).
 *
 * ```js
 * import { task, waitForEvent } from 'ember-concurrency';
 * export default class MyComponent extends Component {
 *   &#64;task *myTask() {
 *     console.log("Please click anywhere..");
 *     let clickEvent = yield waitForEvent($('body'), 'click');
 *     console.log("Got event", clickEvent);
 *
 *     let emberEvent = yield waitForEvent(this, 'foo');
 *     console.log("Got foo event", emberEvent);
 *
 *     // somewhere else: component.trigger('foo', { value: 123 });
 *   }
 * }
 * ```
 *
 * @param {object} object the Ember Object, jQuery element, or other object with .on() and .off() APIs
 *                 that the event fires from
 * @param {function} eventName the name of the event to wait for
 */
export function waitForEvent(object, eventName) {
  assert(
    `${object} must include Ember.Evented (or support \`.on()\` and \`.off()\`) or DOM EventTarget (or support \`addEventListener\` and  \`removeEventListener\`) to be able to use \`waitForEvent\``,
    isEventedObject(object)
  );
  return new WaitForEventYieldable(object, eventName);
}

/**
 * Use `waitForProperty` to pause the task until a property on an object
 * changes to some expected value. This can be used for a variety of use
 * cases, including synchronizing with another task by waiting for it
 * to become idle, or change state in some other way. If you omit the
 * callback, `waitForProperty` will resume execution when the observed
 * property becomes truthy. If you provide a callback, it'll be called
 * immediately with the observed property's current value, and multiple
 * times thereafter whenever the property changes, until you return
 * a truthy value from the callback, or the current task is canceled.
 * You can also pass in a non-Function value in place of the callback,
 * in which case the task will continue executing when the property's
 * value becomes the value that you passed in.
 *
 * ```js
 * import { task, waitForProperty } from 'ember-concurrency';
 * export default class MyComponent extends Component {
 *   &#64;tracked foo = 0;
 *
 *   &#64;task *myTask() {
 *     console.log("Waiting for `foo` to become 5");
 *
 *     yield waitForProperty(this, 'foo', v => v === 5);
 *     // alternatively: yield waitForProperty(this, 'foo', 5);
 *
 *     // somewhere else: this.foo = 5;
 *
 *     console.log("`foo` is 5!");
 *
 *     // wait for another task to be idle before running:
 *     yield waitForProperty(this, 'otherTask.isIdle');
 *     console.log("otherTask is idle!");
 *   }
 * }
 * ```
 *
 * @param {object} object an object (most likely an Ember Object)
 * @param {string} key the property name that is observed for changes
 * @param {function} callbackOrValue a Function that should return a truthy value
 *                                   when the task should continue executing, or
 *                                   a non-Function value that the watched property
 *                                   needs to equal before the task will continue running
 */
export function waitForProperty(object, key, predicateCallback) {
  return new WaitForPropertyYieldable(object, key, predicateCallback);
}
