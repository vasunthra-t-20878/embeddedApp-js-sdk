/**
 * WDK.js — Widget Developer Kit 1.0
 *
 * JavaScript implementation of the ZDK 2.0 API (from ZDK-2.0.ts) with:
 *   • `wdk` prefix instead of `zdk`
 *   • Widget-iframe resolver setup (ZDK_EVENT via appSDK)
 *   • Falls back to the existing CScript _newRequestPromise when in CScript context
 *   • Adds widget-specific APIs not in ZDK-2.0.ts:
 *       wdk.on(event, fn)    — PageLoad / event listener
 *       wdk.store.*          — session storage (alias to window.sessionStorage proxy)
 *       wdk.event.*          — event bus helpers
 *       wdk.client.*         — browser utility helpers
 *
 * Load order (required in widget HTML):
 *   Single bundle: WDK.min.js  (contains ZSDK + Initialization + WDK, auto-inits)
 *   Optional add-ons (after WDK.min.js): ConnectorHelper.js
 *
 *   If loading separately: ZSDK.js -> Initialization.js -> WDK.js
 */
(function (global) {
  'use strict';

  // ── 1. Widget-iframe resolver bootstrap ─────────────────────────────────────
  //
  // In CScript context: self._newRequestPromise is already wired by the CRM runtime.
  // In widget iframe context: it is not present — we set it up here via appSDK.

  if (!self._newRequestPromise) {
    var __wdkSDK;
    function __getWdkSDK() {
      if (!__wdkSDK) { __wdkSDK = self._getAppSDK(); }
      return __wdkSDK;
    }
    self._newRequestPromise = function (data, conf) {
      if (data && !data.wdkVersion) { data.wdkVersion = '1.0'; }
      return __getWdkSDK().getContext().Event.Trigger('ZDK_EVENT', data, true);
    };
  }

  var _newRequestPromise = self._newRequestPromise;

  // ── Backward Compatibility Layer (isolated for easy removal) ────────────────
  // Remove this whole object and replace call-sites with direct ZDKResolver calls
  // once legacy handlers are aligned to ZDK 2.0 action names.
  var WDKCompat = {
    actionMapping: {
      'open_popup': 'open_widget_by_id',
      'open_mailer': 'send_mail'
    },

    remapRequest: function (request) {
      if (request.action === 'open_popup') {
        // ZDK-2.0: { id, type, api_name, crux, config, data }
        // ZDK-1.0: { id, type, api_name, data, config{..., crux} }
        var newConfig = request.config || {};
        if (request.crux) { newConfig.crux = request.crux; }
        request.config = newConfig;
      }

      if (request.action === 'open_mailer') {
        // ZDK-2.0: { action: 'open_mailer', mail_config }
        // ZDK-1.0: { action: 'send_mail', config }
        request.config = request.mail_config;
        delete request.mail_config;
      }

      if (this.actionMapping[request.action]) {
        request.action = this.actionMapping[request.action];
      }
      return request;
    },

    popupClose: function (closeConfig, response) {
      var p = ZDKResolver({ action: 'close_popup', config: closeConfig, response: response });
      if (p && typeof p.then === 'function') {
        return p.catch(function () {
          return ZDKResolver({ action: 'close_widget', config: closeConfig, response: response });
        });
      }
      return p;
    },

    flyoutOpen: function (name, widget, config, data) {
      var type = widget && widget.type;
      config.max_height = "100%";
      config.max_width = "100%";
      var createProm = ZDKResolver({ action: 'create_flyout', name: name, config: config || {} });
      var openReq = function () {
        return ZDKResolver({ action: 'open_flyout', name: name, id: widget && widget.id, type: type, api_name: widget && widget.api_name, config: config || {}, data: data });
      };
      if (createProm && typeof createProm.then === 'function') {
        return createProm.then(function () { return openReq(); });
      }
      return openReq();
    },

    clientOpenURL: function (url, target) {
      return ZDKResolver({ action: 'open_window', url: url, target: target || '_blank', version: '1.0' });
    },

    clientDownloadFile: function (file_name, source) {
      var req = {
        action: 'download_file',
        blob: source instanceof Blob ? source : undefined,
        url: typeof source === 'string' ? source : undefined,
        file_name: file_name || undefined,
        version: '1.0'
      };

      var fallback = function (err) {
        var msg = (err && (err.message || String(err))) || '';
        if (!/unsupported action/i.test(msg)) { throw err; }

        // Browser fallback path when host handler doesn't support download_file.
        if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
          var a = document.createElement('a');
          a.style.display = 'none';
          if (document.body) { document.body.appendChild(a); }

          if (source instanceof Blob) {
            var blobUrl = URL.createObjectURL(source);
            a.href = blobUrl;
            a.download = file_name || 'download';
            a.click();
            if (a.parentNode) { a.parentNode.removeChild(a); }
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 0);
            return true;
          }

          if (typeof source === 'string') {
            a.href = source;
            a.target = '_blank';
            if (file_name) { a.setAttribute('download', file_name); }
            a.click();
            if (a.parentNode) { a.parentNode.removeChild(a); }
            return true;
          }
        }

        // Non-DOM fallback for URL source.
        if (typeof source === 'string') {
          return WDKCompat.clientOpenURL(source, '_blank');
        }

        throw err;
      };

      var p = ZDKResolver(req, { userInput: true });
      if (p && typeof p.then === 'function') { return p.catch(fallback); }
      return p;
    }
  };

  // ── 2. Resolvers (same pattern as ZDK-2.0.ts) ────────────────────────────────

  self.ZDKResolver = function (request, conf) {
    request.version = '1.0';
    WDKCompat.remapRequest(request);
    return _newRequestPromise(request, conf);
  };

  self.ZDK1Resolver = function (request, conf) {
    request.version = '1.0';
    WDKCompat.remapRequest(request);
    return _newRequestPromise(request, conf);
  };

  self.ZDKAPIResolver = function (request) {
    var version = (typeof wdk !== 'undefined' && wdk.Apps && wdk.Apps.CRM)
      ? wdk.Apps.CRM.version
      : undefined;
    return _newRequestPromise({ action: 'api_dispatch', data: request, version: version });
  };

  var ZDKResolver  = self.ZDKResolver;
  var ZDK1Resolver = self.ZDK1Resolver;

  // ── 3. window proxy (same as ZDK-2.0.ts) ────────────────────────────────────
  //  Provides self.window.sessionStorage and self.window.open for worker (CScript)
  //  contexts where no real `window` object exists.
  //  In a browser widget iframe self.window === window (read-only properties) —
  //  we must NOT attempt to overwrite it.

  if (!self.window) {
    // CScript / Web Worker context only — safe to create a full proxy object.
    self.window = {
      open: function (url, target) {
        if (!url || !url.trim()) { throw new Error('URL cannot be empty'); }
        if (target && target !== '_self' && target !== '_blank') {
          throw new Error("target must be either '_self' or '_blank'");
        }
        return _newRequestPromise({ action: 'open_window', url: url, target: target, version: '1.0' });
      },
      sessionStorage: {
        getItem: function (key) {
          return _newRequestPromise({ action: 'session_storage_get', key: key, version: '1.0' });
        },
        setItem: function (key, value) {
          return _newRequestPromise({ action: 'session_storage_set', key: key, value: value, version: '1.0' });
        },
        removeItem: function (key) {
          return _newRequestPromise({ action: 'session_storage_remove', key: key, version: '1.0' });
        },
        clear: function () {
          return _newRequestPromise({ action: 'session_storage_clear', version: '1.0' });
        }
      }
    };
  }

  // ── 4. Internal validator (from ZDK-2.0.ts) ──────────────────────────────────

  function validator(value, key, validations) {
    validations = validations || {};
    if ((!validations.required && value !== undefined || validations.required) &&
        !(validations.allow_null && value === null)) {
      if (typeof value !== 'string' && !(value instanceof String)) {
        throw new Error(key + ' must be a String');
      }
      if (!value.trim()) {
        throw new Error(key + ' cannot be blank');
      }
      if (validations.min_length && value.length < validations.min_length) {
        throw new Error(key + ' must be atleast ' + validations.min_length + ' characters');
      }
      if (validations.max_length && value.length > validations.max_length) {
        throw new Error(key + ' must be atmost ' + validations.max_length + ' characters');
      }
    }
  }

  // ── 5. Helper classes (Field, Subform, etc. — from ZDK-2.0.ts, translated) ──
  //  Used by wdk.components.record_form / record_detail / record_list.
  //  In CScript context they work natively; in widget iframe they resolve
  //  asynchronously (ZDK_EVENT backs the resolver).

  class IUploadFieldSourceOptions {
    constructor(apiName, source) { this.apiName = apiName; this.source = source; }
  }

  class IWorkdriveSourceOptions extends IUploadFieldSourceOptions {
    set folderId(folder_id) {
      return ZDKResolver({ action: 'field_set_folder_id', field_name: this.apiName, value: folder_id, source: this.source });
    }
  }

  class IUploadFieldOptions {
    #apiName;
    constructor(apiName) {
      this.#apiName = apiName;
      this.workDrive = new IWorkdriveSourceOptions(apiName, 'workdrive');
    }
    get allowedSources() { return ZDKResolver({ action: 'field_read',  field_name: this.#apiName }); }
    set allowedSources(v) { return ZDKResolver({ action: 'field_write', field_name: this.#apiName, value: v }); }
  }

  class IFieldConfigurator {
    #apiName;
    constructor(apiName) { this.#apiName = apiName; this.fileUpload = new IUploadFieldOptions(apiName); }
  }

  class IteratorResult {
    constructor(value, done) { this._value = value; this._done = done; }
    get value() { return this._value; }
    set value(v) { this._value = v; }
    get done() { return this._done; }
    set done(v) { this._done = v; }
  }

  class Iterator {
    constructor(api_name, filter, limit, offset) {
      this.unique_key = Math.floor(10000000 + Math.random() * 90000000);
      this.api_name = api_name; this.filter = filter;
      this.limit = limit; this.offset = offset; this.current_index = 0;
    }
    next() {
      var nv = ZDKResolver({ action: 'field_iterator', api_name: this.api_name, subform_details: this.subform_details, unique_key: this.unique_key, current_index: this.current_index, filter: this.filter, limit: this.limit, offset: this.offset });
      this.current_index++;
      return new IteratorResult(nv.value, nv.done);
    }
    reset() { return new Iterator(this.api_name, this.subform_details, this.filter, this.limit, this.offset); }
  }

  /**
   * Class representing a Field in a form/list/detail page.
   * @category Objects
   */
  class Field {
    static className = 'Field';
    #apiName; #selector; #resolver;
    constructor(apiName, selector, resolver) {
      this.#apiName = apiName; this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    /**
     * @summary Get the API name of this field
     * @function
     * @returns {String} API name
     */
    getApiName() { return this.#apiName; }
    #sel(extra) { return Object.assign({ field_name: this.#apiName, ...(this.#selector ? { selector: this.#selector } : {}) }, extra || {}); }
    /**
     * @summary Mask field value with a character
     * @function
     * @param {Object} config - Masking configuration
     * @param {Number} config.length - Length of characters to mask
     * @param {String} config.character - Character to use for masking
     * @param {Boolean} [config.reverse] - Masking to be done in reverse (true/false)
     * @returns {Promise} Result of mask operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').mask({length: 8, character: '#'});
     */
    mask(config) {
      if (!config.length || config.length < 1) { throw new Error('invalid length - ' + config.length); }
      return this.#resolver({ action: 'field_mask', ...this.#sel(), config });
    }
    /**
     * @summary Set validation error message for field
     * @function
     * @param {String} message - Error message to display
     * @returns {Promise} Result of error setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').error('Invalid email format');
     * @example <caption>Clear error</caption>
     * zdk.components.record_form.field('Email').error(null);
     */
    error(message) {
      if (typeof message === 'string' || message instanceof String) { return this.#resolver({ action: 'field_set_error', ...this.#sel(), value: message }); }
      throw new TypeError('First argument must be a String');
    }
    /**
     * @summary Set field value
     * @function
     * @param {*} value - Value to set for the field
     * @returns {Promise} Result of value setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Last_Name').setValue('Zylker');
     */
    setValue(value)  { return this.#resolver({ action: 'field_write',        ...this.#sel(), value }); }
    /**
     * @summary Get field value
     * @function
     * @returns {*} Current field value
     * @example <caption>Sample</caption>
     * var fieldValue = zdk.components.record_form.field('Last_Name').getValue();
     * @example <caption>Output</caption>
     * 'Zylker'
     */
    getValue()       { return this.#resolver({ action: 'field_read',         ...this.#sel() }); }
    /**
     * @summary Set field as mandatory/optional
     * @function
     * @param {Boolean} value - true to make mandatory, false to make optional
     * @returns {Promise} Result of mandate setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').mandate(true);
     */
    mandate(value)   { return this.#resolver({ action: 'field_set_required', ...this.#sel(), value }); }
    /**
     * @summary Set maximum length for field
     * @function
     * @param {Number} value - Maximum character length allowed
     * @returns {Promise} Result of maxlength setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').maxlength(100);
     */
    maxlength(value) { return this.#resolver({ action: 'field_set_max_length', ...this.#sel(), value }); }
    /**
     * @summary Lock/Unlock field (prevent user edits)
     * @function
     * @param {Boolean} value - true to lock, false to unlock
     * @returns {Promise} Result of lock operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').lock(true);
     */
    lock(value)      { return this.#resolver({ action: 'field_set_read_only', ...this.#sel(), value }); }
    /**
     * @summary Show/Hide field
     * @function
     * @param {Boolean} value - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').display(true);
     */
    display(value)   { return this.#resolver({ action: 'field_visibility',   ...this.#sel(), value }); }
    /**
     * @summary Apply CSS styles to field
     * @function
     * @param {Object} config - Style configuration object
     * @param {String} [config.backgroundColor] - CSS background color
     * @param {String} [config.foregroundColor] - CSS text color
     * @param {String} [config.fontWeight] - CSS font weight (bold, normal, etc.)
     * @returns {Promise} Result of style application
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').style({backgroundColor: '#ff0000', foregroundColor: 'white'});
     */
    style(style_config) {
      for (var c in style_config) {
        if (!style_config[c] || typeof style_config[c] === 'string' && !style_config[c].trim()) { throw new Error(c + ' cannot be empty'); }
      }
      return this.#resolver({ action: 'field_style_add', ...this.#sel(), style_config });
    }
    /**
     * @summary Set info icon/tooltip for field
     * @function
     * @param {String} message - Info message to display (max 255 characters)
     * @returns {Promise} Result of info setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').info('Enter a valid email address');
     */
    info(message) {
      validator(message, 'message', { min_length: 1, max_length: 255, required: true });
      return this.#resolver({ action: 'field_info_add', ...this.#sel(), message });
    }
    /**
     * @summary Set tooltip for field
     * @function
     * @param {String} message - Tooltip text to display (max 180 characters)
     * @returns {Promise} Result of tooltip setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').tooltip('Your email address');
     */
    tooltip(message) {
      validator(message, 'message', { min_length: 1, max_length: 180, required: true });
      return this.#resolver({ action: 'field_tooltip_add', ...this.#sel(), message });
    }
    /**
     * @summary Set filter criteria for lookup/picklist fields
     * @function
     * @param {String} criteria - Filter criteria expression
     * @param {Object} [config] - Additional configuration for filtering
     * @returns {Promise} Result of criteria setting
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Account_Name').criteria('((Last_Name:equals:Burns))');
     */
    criteria(criteria, config) { return this.#resolver({ action: 'field_set_criteria', ...this.#sel(), criteria, config }); }
    /**
     * @summary Bulk-set multiple field properties in one call
     * @function
     * @param {Object} config - Property map for field configuration
     * @param {Boolean} [config.mandate] - Set mandatory attribute
     * @param {Boolean} [config.lock] - Lock/Unlock the field
     * @param {Boolean} [config.display] - Set visibility (show/hide)
     * @param {Number} [config.maxlength] - Set maximum length
     * @param {String} [config.criteria] - Set filter criteria
     * @returns {Promise} Result of config operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Email').config({ mandate: true, lock: false, display: true, maxlength: 100 });
     */
    config(config) {
      if (config.mandate   !== undefined) { this.mandate(config.mandate); }
      if (config.lock      !== undefined) { this.lock(config.lock); }
      if (config.display   !== undefined) { this.display(config.display); }
      if (config.maxlength !== undefined) { this.maxlength(config.maxlength); }
      if (config.criteria  !== undefined) { this.criteria(config.criteria, undefined); }
    }
    /**
     * @summary Get picklist/multiselectpicklist options
     * @function
     * @returns {Array} Array of option objects with id and name
     * @example <caption>Sample</caption>
     * var options = zdk.components.record_form.field('Status').getPicklistOptions();
     * @example <caption>Output</caption>
     * [{ id: '1', name: 'Active' }, { id: '2', name: 'Inactive' }]
     */
    getPicklistOptions() { return this.#resolver({ action: 'field_get_options',    ...this.#sel() }); }
    setSuggestions(suggestions) { return this.#resolver({ action: 'field_set_suggestions', ...this.#sel(), suggestions }); }
    getSuggestions()     { return this.#resolver({ action: 'field_get_suggestions', ...this.#sel() }); }
    patchValue(value)    { return this.#resolver({ action: 'field_patch',           ...this.#sel(), value }); }
    getValueIterator(opts) { opts = opts || {}; return new Iterator(this.getApiName(), opts.filter, opts.limit, opts.offset); }
    getConfigurator()    { return new IFieldConfigurator(this.getApiName()); }
  }

  class Subform {
    static className = 'Subform';
    #apiName; #selector; #resolver;
    constructor(api_name, selector, resolver) {
      this.#apiName = api_name; this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    getApiName() { return this.#apiName; }
    #s(extra) { return { ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    field(api_name) {
      return new SubformField(api_name, this.getApiName(), this.#selector, this.#resolver);
    }
    setValues(values) {
      var obj = {}; obj[this.getApiName()] = values;
      return this.#resolver({ action: 'subform_write', req_data: obj, subform_api_name: this.getApiName(), ...this.#s() });
    }
    getValues() { return this.#resolver({ action: 'subform_read', api_name: this.getApiName(), ...this.#s() }); }
    row(index) {
      if (index !== 0 && !index) { throw new Error('Index is a mandatory param'); }
      if (typeof index !== 'number') { throw new TypeError('Index must be a number, not a ' + typeof index); }
      if (index < 0) { return null; }
      return new SubformRow(index, this.getApiName(), this.#selector, this.#resolver);
    }
    insertRows(values, index) {
      if (index && typeof index !== 'number') { throw new TypeError('Index must be a number, not a ' + typeof index); }
      return this.#resolver({ action: 'subform_add_row', subform_api_name: this.getApiName(), index: index !== undefined ? index : undefined, values, ...this.#s() });
    }
    deleteRow(index) {
      if (index !== 0 && !index) { throw new Error('Index is a mandatory param'); }
      if (typeof index !== 'number') { throw new TypeError('Index must be a number, not a ' + typeof index); }
      if (index < 0) { throw new Error('Index value cannot be lesser than 0'); }
      return this.#resolver({ action: 'subform_delete_row', subform_api_name: this.getApiName(), index, ...this.#s() });
    }
    clear() {
      var obj = {}; obj[this.getApiName()] = [];
      return this.#resolver({ action: 'subform_write', req_data: obj, validate: false, ...this.#s() });
    }
    mandate(value) { return this.#resolver({ action: 'set_subform_mandatory', field_name: this.getApiName(), value, ...this.#s() }); }
    info(message) {
      validator(message, 'message', { min_length: 1, max_length: 255, required: true, allow_null: true });
      return this.#resolver({ action: 'set_subform_info', field_name: this.getApiName(), message, ...this.#s() });
    }
    config(config) {
      if (config.mandate !== undefined) { this.mandate(config.mandate); }
      if (config.info    !== undefined) { this.info(config.info); }
    }
  }

  class SubformRow {
    static className = 'SubformRow';
    #index; #parent; #selector; #resolver;
    constructor(index, parent, selector, resolver) {
      this.#index = index; this.#parent = parent; this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    getIndex()  { return this.#index; }
    getParent() { return this.#parent; }
    #s(extra) { return { ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    getValues() {
      var row = this.#resolver({ action: 'subform_read_row', api_name: this.getParent(), index: this.getIndex(), ...this.#s() });
      return row || null;
    }
    setValues(values) { return this.#resolver({ action: 'subform_write_row', api_name: this.getParent(), index: this.getIndex(), values, ...this.#s() }); }
    cell(api_name) {
      return new SubformCell(this.getParent(), this.getIndex(), api_name, this.#selector, this.#resolver);
    }
    lock(value) { return this.#resolver({ action: 'set_row_readonly', subform_api_name: this.getParent(), index: this.getIndex(), value, ...this.#s() }); }
  }

  class SubformCell {
    static className = 'SubformCell';
    #parent; #index; #apiName; #selector; #resolver;
    constructor(parent, index, api_name, selector, resolver) {
      this.#parent = parent; this.#index = index; this.#apiName = api_name;
      this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    getParent()  { return this.#parent; }
    getIndex()   { return this.#index; }
    getApiName() { return this.#apiName; }
    #s(extra) { return { ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    getValue() { return this.#resolver({ action: 'subform_read_cell', parent: this.getParent(), index: this.getIndex(), api_name: this.getApiName(), ...this.#s() }); }
    setValue(value) { return this.#resolver({ action: 'subform_write_cell', parent: this.getParent(), index: this.getIndex(), api_name: this.getApiName(), value, ...this.#s() }); }
    lock(value) { return this.#resolver({ action: 'cell_set_readonly', api_name: this.getParent(), field_name: this.getApiName(), index: this.getIndex(), value, ...this.#s() }); }
    error(message) {
      if (typeof message === 'string' || message instanceof String || message === null) {
        return this.#resolver({ action: 'cell_set_error', api_name: this.getParent(), field_name: this.getApiName(), index: this.getIndex(), value: message, ...this.#s() });
      }
      throw new TypeError('First argument must be a String');
    }
    config(config) {
      if (config.error !== undefined) { this.error(config.error); }
      if (config.lock  !== undefined) { this.lock(config.lock); }
    }
  }

  class SubformField {
    static className = 'SubformField';
    #parent; #apiName; #selector; #resolver;
    constructor(api_name, parent, selector, resolver) {
      this.#apiName = api_name; this.#parent = parent;
      this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    getApiName() { return this.#apiName; }
    #s(extra) { return { parent: this.#parent, ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    criteria(criteria, config) { return ZDKResolver({ action: 'subform_set_criteria', field_name: this.getApiName(), criteria, config, ...this.#s() }); }
    lock(value)    { return this.#resolver({ action: 'subform_set_column_readonly',  value, field_name: this.getApiName(), ...this.#s() }); }
    mandate(value) { return this.#resolver({ action: 'subform_set_column_mandatory', value, field_name: this.getApiName(), ...this.#s() }); }
    info(message) {
      validator(message, 'message', { min_length: 1, max_length: 255, required: true, allow_null: true });
      return this.#resolver({ action: 'subform_set_column_info', field_name: this.getApiName(), message, ...this.#s() });
    }
    display(value) { return this.#resolver({ action: 'subform_set_column_visibility', value, field_name: this.getApiName(), ...this.#s() }); }
    config(config) {
      if (config.mandate !== undefined) { this.mandate(config.mandate); }
      if (config.display !== undefined) { this.display(config.display); }
      if (config.info    !== undefined) { this.info(config.info); }
      if (config.lock    !== undefined) { this.lock(config.lock); }
    }
  }

  /**
   * Class representing a Blueprint Transition.
   * @category Objects
   */
  class BlueprintTransition {
    static className = 'BlueprintTransition';
    #id; #name; #selector; #resolver;
    constructor(id, name, selector, resolver) {
      this.#id = id; this.#name = name; this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    /**
     * @summary Get the name of transition
     * @function
     * @returns {String} Transition name
     */
    getName()  { return this.#name; }
    /**
     * @summary Get the internal ID of this transition
     * @function
     * @returns {String} Transition ID
     */
    getId()    { return this.#id; }
    /**
     * @summary Initiate the transition (page will refresh after)
     * @function
     */
    initiate() { return this.#resolver({ action: 'initiate_blueprint_action', id: this.#id, ...(this.#selector ? { selector: this.#selector } : {}) }); }
  }

  /**
   * Class representing a Button in a page.
   * @category Objects
   */
  class Button {
    static className = 'Button';
    #apiName; #id; #name; #type; #selector; #resolver;
    constructor(apiname, id, name, type, selector, resolver) {
      this.#apiName = apiname; this.#id = id; this.#name = name; this.#type = type;
      this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    #s(extra) { return { id: this.#id, api_name: this.getApiName(), ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get button type (system or custom)
     * @function
     * @returns {String} Button type ('system' or 'custom')
     * @example <caption>Sample</caption>
     * var type = zdk.components.record_form.button('record_save').getType();
     * @example <caption>Output</caption>
     * 'system'
     */
    getType()    { return this.#type; }
    /**
     * @summary Get button API name
     * @function
     * @returns {String} Button API name
     * @example <caption>Sample</caption>
     * var apiName = zdk.components.record_form.button('record_save').getApiName();
     * @example <caption>Output</caption>
     * 'record_save'
     */
    getApiName() { return this.#apiName; }
    /**
     * @summary Get button internal ID
     * @function
     * @returns {String} Button internal ID
     * @example <caption>Sample</caption>
     * var id = zdk.components.record_form.button('record_save').getId();
     */
    getId()      { return this.#id; }
    /**
     * @summary Get button label/display text
     * @function
     * @returns {String} Button label text
     * @example <caption>Sample</caption>
     * var label = zdk.components.record_form.button('record_save').getLabel();
     * @example <caption>Output</caption>
     * 'Save'
     */
    getLabel() {
      if (this.#name) { return this.#name; }
      return this.#resolver({ action: 'button_get_value', ...this.#s() });
    }
    /**
     * @summary Trigger button click
     * @function
     * @returns {Promise} Result of button click
     * @example <caption>Sample</caption>
     * zdk.components.record_form.button('record_save').click();
     */
    click()      { return this.#resolver({ action: 'button_click',   ...this.#s() }); }
    /**
     * @summary Disable button (prevent clicks)
     * @function
     * @returns {Promise} Result of disable operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.button('record_save').disable();
     */
    disable()    { return this.#resolver({ action: 'button_disable', ...this.#s() }); }
    /**
     * @summary Enable button (allow clicks)
     * @function
     * @returns {Promise} Result of enable operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.button('record_save').enable();
     */
    enable()     { return this.#resolver({ action: 'button_enable',  ...this.#s() }); }
    hide()       { return this.#resolver({ action: 'button_hide',    ...this.#s() }); }
    show()       { return this.#resolver({ action: 'button_show',    ...this.#s() }); }
    /**
     * @summary Set button label/display text
     * @function
     * @param {String} value - New button label (max 30 characters)
     * @returns {Promise} Result of label update
     * @example <caption>Sample</caption>
     * zdk.components.record_form.button('record_save').label('Save & Continue');
     */
    label(value) {
      if (typeof value === 'string' || value instanceof String) {
        if (value.length > 30) { throw new Error('First argument must be atmost 30 characters'); }
        if (!value.trim())     { throw new Error('First argument cannot be blank'); }
        return this.#resolver({ action: 'button_set_value', value, ...this.#s() });
      }
      throw new TypeError('First argument must be a String');
    }
  }

  /**
   * Class representing a Link in a page.
   * @category Objects
   */
  class Link {
    static className = 'Link';
    #id; #name; #selector; #resolver;
    constructor(id, name, selector, resolver) {
      this.#id = id; this.#name = name; this.#selector = selector; this.#resolver = resolver || ZDKResolver;
    }
    /**
     * @summary Get link name
     * @function
     * @returns {String} Link name
     * @example <caption>Sample</caption>
     * var name = zdk.components.record_detail.links()[0].getName();
     * @example <caption>Output</caption>
     * 'my_link'
     */
    getName() { return this.#name; }
    /**
     * @summary Get link internal ID
     * @function
     * @returns {String} Link ID
     * @example <caption>Sample</caption>
     * var linkId = zdk.components.record_detail.links()[0].getId();
     */
    getId()   { return this.#id; }
    #s(extra) { return { name: this.getName(), id: this.#id, ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Trigger link click
     * @function
     * @returns {Promise} Result of link click
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.links()[0].click();
     */
    click()   { return this.#resolver({ action: 'link_click',   ...this.#s() }); }
    /**
     * @summary Disable link
     * @function
     * @returns {Promise} Result of disable operation
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.links()[0].disable();
     */
    disable() { return this.#resolver({ action: 'link_disable', ...this.#s() }); }
    /**
     * @summary Enable link
     * @function
     * @returns {Promise} Result of enable operation
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.links()[0].enable();
     */
    enable()  { return this.#resolver({ action: 'link_enable',  ...this.#s() }); }
  }

  /**
   * Class representing the Page Selection component (canvas/wizard page tabs).
   * @category Objects
   */
  class PageSelection {
    static className = 'PageSelection';
    #selector; #resolver;
    constructor(selector, resolver) { this.#selector = selector; this.#resolver = resolver || ZDKResolver; }
    #s(extra) { return { name: 'page-selection', ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get the current active page/tab value
     * @function
     * @returns {*} Current page value (page API name)
     * @example <caption>Sample</caption>
     * var currentPage = zdk.components.record_form.page_selection.getValue();
     * @example <caption>Output</caption>
     * 'canvas_view_1'
     */
    getValue()      { return this.#resolver({ action: 'component_get_value', ...this.#s() }); }
    /**
     * @summary Navigate to a specific page/canvas view
     * @function
     * @param {String} value - API name of the page to navigate to
     * @returns {Promise} Result of navigation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.page_selection.setValue('canvas_view_api_name');
     */
    setValue(value) { return this.#resolver({ action: 'component_set_value', value, ...this.#s() }); }
    /**
     * @summary Show or hide the page selector
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.page_selection.display(true);
     */
    display(flag)   { return this.#resolver({ action: flag ? 'component_show' : 'component_hide', ...this.#s() }); }
  }

  /**
   * Class representing the Layout Selection component in a record form page.
   * @category Objects
   */
  class LayoutSelection {
    static className = 'LayoutSelection';
    #selector; #resolver;
    constructor(selector, resolver) { this.#selector = selector; this.#resolver = resolver || ZDKResolver; }
    #s(extra) { return { name: 'layout-selection', ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get the currently active layout value
     * @function
     * @returns {*} Current layout ID
     * @example <caption>Sample</caption>
     * var layoutId = zdk.components.record_form.layout_selection.getValue();
     * @example <caption>Output</caption>
     * '43125880000000XXXX'
     */
    getValue()      { return this.#resolver({ action: 'component_get_value',   ...this.#s() }); }
    /**
     * @summary Set the active layout
     * @function
     * @param {String} value - Layout ID to activate
     * @returns {Promise} Result of layout change
     * @example <caption>Sample</caption>
     * zdk.components.record_form.layout_selection.setValue('43125880000000XXXX');
     */
    setValue(value) { return this.#resolver({ action: 'component_set_value',   value, ...this.#s() }); }
    /**
     * @summary Show or hide the layout selector
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.layout_selection.display(false);
     */
    display(flag)   { return this.#resolver({ action: flag ? 'component_show' : 'component_hide', ...this.#s() }); }
    /**
     * @summary Get available layout options
     * @function
     * @returns {Array} Array of layout option objects
     * @example <caption>Sample</caption>
     * var layouts = zdk.components.record_form.layout_selection.getOptions();
     */
    getOptions()    { return this.#resolver({ action: 'component_get_options', ...this.#s() }); }
  }

  /**
   * Class representing the Custom View Selection dropdown in a list page.
   * @category Objects
   */
  class CustomViewSelection {
    static className = 'CustomViewSelection';
    #selector; #resolver;
    constructor(selector, resolver) { this.#selector = selector; this.#resolver = resolver || ZDKResolver; }
    #s(extra) { return { name: 'list-custom-view', ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get the currently active custom view value
     * @function
     * @returns {*} Current custom view ID
     * @example <caption>Sample</caption>
     * var viewId = zdk.components.record_list.custom_view_selection.getValue();
     * @example <caption>Output</caption>
     * '43125880000000XXXX'
     */
    getValue()          { return this.#resolver({ action: 'component_get_value',   ...this.#s() }); }
    /**
     * @summary Set the active custom view
     * @function
     * @param {String} value - Custom view ID to activate
     * @returns {Promise} Result of custom view change
     * @example <caption>Sample</caption>
     * zdk.components.record_list.custom_view_selection.setValue('43125880000000XXXX');
     */
    setValue(value)     { return this.#resolver({ action: 'component_set_value',   value, ...this.#s() }); }
    /**
     * @summary Show or hide the custom view selector
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.custom_view_selection.display(false);
     */
    display(flag)       { return this.#resolver({ action: flag ? 'component_show' : 'component_hide', ...this.#s() }); }
    /**
     * @summary Get available custom view options
     * @function
     * @returns {Array} Array of custom view option objects
     * @example <caption>Sample</caption>
     * var views = zdk.components.record_list.custom_view_selection.getOptions();
     */
    getOptions()        { return this.#resolver({ action: 'component_get_options', ...this.#s() }); }
    /**
     * @summary Set available custom view options
     * @function
     * @param {Array} options - Array of option objects with id property
     * @returns {Promise} Result of options update
     * @example <caption>Sample</caption>
     * zdk.components.record_list.custom_view_selection.setOptions([{ id: '43125880000000XXXX' }, { id: '43125880000000YYYY' }]);
     */
    setOptions(options) { return this.#resolver({ action: 'component_set_options', options, ...this.#s() }); }
  }

  /**
   * Class representing the View Type Selection dropdown in a list page (list/kanban/canvas etc.).
   * @category Objects
   */
  class ViewTypeSelection {
    static className = 'ViewTypeSelection';
    #selector; #resolver;
    constructor(selector, resolver) { this.#selector = selector; this.#resolver = resolver || ZDKResolver; }
    #s(extra) { return { name: 'list-view-type', ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get the current view type value
     * @function
     * @returns {*} Current view type (list, kanban, canvas, etc.)
     * @example <caption>Sample</caption>
     * var viewType = zdk.components.record_list.view_type_selection.getValue();
     * @example <caption>Output</caption>
     * 'kanban'
     */
    getValue()      { return this.#resolver({ action: 'component_get_value', ...this.#s() }); }
    /**
     * @summary Set the active view type
     * @function
     * @param {String} value - View type to set (list, kanban, canvas, etc.)
     * @returns {Promise} Result of view type change
     * @example <caption>Sample</caption>
     * zdk.components.record_list.view_type_selection.setValue('kanban');
     */
    setValue(value) { return this.#resolver({ action: 'component_set_value', value, ...this.#s() }); }
    /**
     * @summary Show or hide the view type selector
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.view_type_selection.display(false);
     */
    display(flag)   { return this.#resolver({ action: flag ? 'component_show' : 'component_hide', ...this.#s() }); }
  }

  /**
   * Class representing the Notes Editor component embedded in a page.
   * @category Objects
   */
  class NotesEditor {
    static className = 'NotesEditor';
    #selector; #resolver;
    constructor(selector, resolver) { this.#selector = selector; this.#resolver = resolver || ZDKResolver; }
    #s(extra) { return { name: 'notes-editor', ...(this.#selector ? { selector: this.#selector } : {}), ...(extra || {}) }; }
    /**
     * @summary Get the current notes editor value/content
     * @function
     * @returns {*} Current notes content
     * @example <caption>Sample</caption>
     * var notes = zdk.components.record_detail.notes_editor.getValue();
     * @example <caption>Output</caption>
     * 'Customer meeting scheduled for Monday'
     */
    getValue()      { return this.#resolver({ action: 'component_get_value', ...this.#s() }); }
    /**
     * @summary Set the notes editor value/content
     * @function
     * @param {*} value - Notes content to set
     * @returns {Promise} Result of notes update
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.notes_editor.setValue('Updated note content');
     */
    setValue(value) { return this.#resolver({ action: 'component_set_value', value, ...this.#s() }); }
    /**
     * @summary Show or hide the notes editor
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.notes_editor.display(true);
     */
    display(flag)   { return this.#resolver({ action: flag ? 'component_show' : 'component_hide', ...this.#s() }); }
  }

  /**
   * Class representing a UI element on a Canvas or Wizard page.
   * @category Objects
   */
  class UIElement {
    #id;
    constructor(id) { this.#id = id; }
    /**
     * @summary Get element ID
     * @function
     * @returns {String} Element ID
     * @example <caption>Sample</caption>
     * var elemId = elem.getId();
     */
    getId()   { return this.#id; }
    /**
     * @summary Show or hide element
     * @function
     * @param {Boolean} flag - true to show, false to hide
     * @returns {Promise} Result of display operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').display(true);
     */
    display(flag)       { return ZDKResolver({ action: flag ? 'canvas_show' : 'canvas_hide',      id: this.#id }); }
    /**
     * @summary Add tooltip for element
     * @function
     * @param {Object} config - Tooltip configuration
     * @param {String} config.text - Tooltip text to display
     * @returns {Promise} Result of tooltip addition
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').tooltip({text: 'Help text here'});
     */
    tooltip(config)     { return ZDKResolver({ action: 'canvas_tooltip_add',                      id: this.#id, config }); }
    /**
     * @summary Remove tooltip for element
     * @function
     * @returns {Promise} Result of tooltip removal
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').removeToolTip();
     */
    removeToolTip()     { return ZDKResolver({ action: 'canvas_toooltip_remove',                  id: this.#id }); }
    /**
     * @summary Apply CSS styles to element
     * @function
     * @param {Object} config - CSS style configuration
     * @returns {Promise} Result of style application
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').style({'background-color': 'red', color: 'white'});
     */
    style(config)       { return ZDKResolver({ action: 'canvas_set_style',                        id: this.#id, config }); }
    /**
     * @summary Freeze element (prevent modifications)
     * @function
     * @param {Boolean} value - true to freeze, false to unfreeze
     * @returns {Promise} Result of freeze operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').freeze(true);
     */
    freeze(value)       { return ZDKResolver({ action: 'canvas_freeze',                           id: this.#id, value }); }
    /**
     * @summary Lock/Unlock element for editing
     * @function
     * @param {Boolean} value - true to lock, false to unlock
     * @returns {Promise} Result of lock operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('relatedList').lock(true);
     */
    lock(value)         { return ZDKResolver({ action: 'set_related_list_readonly',               id: this.#id, value }); }
    /**
     * @summary Set text content for element
     * @function
     * @param {String} value - Text content to display
     * @returns {Promise} Result of content update
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('textElement').setContent('New text content');
     */
    setContent(value)   { return ZDKResolver({ action: 'canvas_set_content',                      id: this.#id, value }); }
    /**
     * @summary Set image for element
     * @function
     * @param {Object} value - Image configuration
     * @param {String} value.type - Type: 'url' or 'userId'
     * @param {String} [value.url] - Image URL (if type='url')
     * @param {String} [value.userId] - User ID (if type='userId')
     * @returns {Promise} Result of image update
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('imgElement').setImage({type: 'url', url: 'https://example.com/image.jpg'});
     */
    setImage(value)     { return ZDKResolver({ action: 'canvas_set_image',                        id: this.#id, value }); }
    /**
     * @summary Set active tab in container
     * @function
     * @returns {Promise} Result of setActive operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('tabContainer').setActive();
     */
    setActive()         { return ZDKResolver({ action: 'canvas_tab_set_active',                   id: this.#id }); }
    /**
     * @summary Scroll page to element location
     * @function
     * @returns {Promise} Result of scroll operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').scrollTo();
     */
    scrollTo()          { return ZDKResolver({ action: 'canvas_scrollTo',                         id: this.#id }); }
    /**
     * @summary Highlight element
     * @function
     * @param {Object} config - Highlight configuration
     * @param {Number} [config.time] - Duration to highlight in milliseconds
     * @returns {Promise} Result of highlight operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').highlight({time: 1000});
     */
    highlight(config)   { return ZDKResolver({ action: 'canvas_blink',                            id: this.#id, config }); }
  }

  // ── Abstract base page classes ───────────────────────────────────────────────

  // Needed by class methods below: if ZDKResolver returned a Promise (iframe context),
  // chains mapFn via .then(); otherwise calls mapFn directly (CScript sync context).
  // Declared here as a function declaration so it is hoisted to the IIFE scope and
  // available both above and below this point in the source.
  function _resolveAndMap(p, mapFn) {
    if (p && typeof p.then === 'function') { return p.then(mapFn); }
    return mapFn(p);
  }

  class RecordPageBase {
    #module;
    constructor(module) { this.#module = module; }
    /**
     * @summary Get page context information
     * @memberof RecordPageBase
     * @function
     * @returns {Object|Promise} Page info object (module, layout_id, component, record_id, etc.)
     * @example <caption>Sample</caption>
     * zdk.components.record_form.getInfo();
     * @example <caption>Output</caption>
     * { module: 'Leads', layout_id: '527627200000009XXXX', component: 'record_form' }
     */
    getInfo() {
      var self_module = this.#module;
      var className = this.constructor.className;
      return _resolveAndMap(
        ZDKResolver({ action: 'page_info', config: { include_module_apiname: true } }),
        function (pi) {
          return {
            module: self_module || (pi && (pi.module_apiname || pi.module)),
            layout_id: pi && pi.layout_id,
            component: className && className.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
          };
        }
      );
    }
    /**
     * @summary Get a button by API name
     * @memberof RecordPageBase
     * @function
     * @param {String} api_name - Button API name
     * @returns {Button|null} Button object or null if not found
     * @example <caption>Sample</caption>
     * var saveBtn = zdk.components.record_form.button('record_save');
     * @example <caption>Output</caption>
     * Button { #apiName: 'record_save', #name: 'Save', #type: 'system' }
     */
    button(api_name) {
      return _resolveAndMap(
        ZDKResolver({ action: 'get_button_apiname', api_name }),
        function (b) { return b ? new Button(b.api_name, null, b.name, b.type, 'root') : null; }
      );
    }
    /**
     * @summary Get all buttons in the page
     * @memberof RecordPageBase
     * @function
     * @returns {Button[]|Promise} Array of Button objects
     * @example <caption>Sample</caption>
     * var allButtons = zdk.components.record_form.buttons();
     * @example <caption>Iterate buttons</caption>
     * allButtons.forEach(btn => console.log(btn.getLabel()));
     */
    buttons() {
      return _resolveAndMap(
        ZDKResolver({ action: 'button_list' }),
        function (list) { return list.map(function (x) { return new Button(x.api_name, x.id, x.name, x.type, 'root'); }); }
      );
    }
    /**
     * @summary Get a UI element by ID for Canvas/Wizard page interactions
     * @memberof RecordPageBase
     * @function
     * @param {String} element_id - Element ID on Canvas or Wizard page
     * @returns {UIElement|null} UIElement object or null if not found
     * @example <caption>Sample</caption>
     * var elem = zdk.components.record_form.ui_element('mySection');
     * elem.display(false);
     * @example <caption>With methods</caption>
     * zdk.components.record_form.ui_element('myElem').style({'background-color': 'red'});
     */
    ui_element(element_id) {
      return _resolveAndMap(
        ZDKResolver({ action: 'get_elem', id: element_id }),
        function (a) { return a ? new UIElement(a.id) : null; }
      );
    }
  }

  class RecordFormPageBase extends RecordPageBase {
    /**
     * @summary Get a field by API name
     * @memberof RecordFormPageBase
     * @function
     * @param {String} api_name - Field API name
     * @returns {Field|null} Field object or null if not found
     * @example <caption>Sample</caption>
     * var emailField = zdk.components.record_form.field('Email');
     * emailField.setValue('test@example.com');
     * @example <caption>Chain operations</caption>
     * zdk.components.record_form.field('Last_Name').lock(true).mandate(true);
     */
    field(api_name) {
      // Construct directly — in iframe ZDKResolver returns a Promise, so using its
      // result synchronously yields undefined api_name and breaks all field method calls.
      return new Field(api_name, 'root');
    }
    /**
     * @summary Get all fields in the page
     * @memberof RecordFormPageBase
     * @function
     * @returns {Field[]|Promise} Array of Field objects
     * @example <caption>Sample</caption>
     * var allFields = zdk.components.record_form.fields();
     * @example <caption>Iterate and configure</caption>
     * allFields.forEach(fld => fld.display(true));
     */
    fields() {
      return _resolveAndMap(
        ZDKResolver({ action: 'form_read' }),
        function (fs) { return Object.keys(fs).map(function (x) { return new Field(x, 'root'); }); }
      );
    }
    /**
     * @summary Get a subform by API name
     * @memberof RecordFormPageBase
     * @function
     * @param {String} api_name - Subform API name
     * @returns {Subform|Promise} Subform object
     * @example <caption>Sample</caption>
     * var subform = zdk.components.record_form.subform('LineItems');
     * var rows = subform.getValues();
     * @example <caption>Add row</caption>
     * subform.insertRows({Name: 'Item1', Quantity: 5}, 0);
     */
    subform(api_name) {
      // Construct directly — same reason as field().
      return new Subform(api_name, 'root');
    }
    /**
     * @summary Get all form field values as a plain object
     * @memberof RecordFormPageBase
     * @function
     * @returns {Object|Promise} Field api_name → value map
     * @example <caption>Sample</caption>
     * var values = zdk.components.record_form.getValues();
     * @example <caption>Output</caption>
     * { Last_Name: 'Zylker', Email: 'zylker@example.com', Phone: '+1234567890' }
     */
    getValues() { return ZDKResolver({ action: 'form_read',   selector: 'root' }); }
    /**
     * @summary Set multiple form field values in one call
     * @memberof RecordFormPageBase
     * @function
     * @param {Object} values - Field api_name → value map
     * @returns {Promise} Result of values update
     * @example <caption>Sample</caption>
     * zdk.components.record_form.setValues({ Last_Name: 'Zylker', Email: 'zylker@example.com' });
     * @example <caption>Multiple fields</caption>
     * zdk.components.record_form.setValues({ First_Name: 'John', Last_Name: 'Doe', Phone: '555-1234' });
     */
    setValues(values) { return ZDKResolver({ action: 'form_write', req_data: values, selector: 'root' }); }
    /**
     * @summary Bulk-set field properties across multiple fields in one call
     * @memberof RecordFormPageBase
     * @function
     * @param {Object} config - Map of field api_name → property config
     * @param {Boolean} [config[field].mandate] - Set mandatory attribute
     * @param {Boolean} [config[field].lock] - Lock/Unlock field
     * @param {Boolean} [config[field].display] - Set visibility
     * @param {Number} [config[field].maxlength] - Set max length
     * @returns {Promise} Result of config operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.config({
     *   Last_Name: { mandate: true, lock: false },
     *   Email: { display: true, maxlength: 100 },
     *   Phone: { display: false }
     * });
     */
    config(config) { return ZDKResolver({ action: 'form_config', req_data: config, selector: 'root' }); }
  }

  /**
   * Class representing a Record Create/Edit/Clone page Instance.
   * @class RecordForm
   * @category Components
   */
  class RecordForm extends RecordFormPageBase {
    static className = 'RecordForm';
    constructor(module) { super(module); }
    /**
     * @summary Get a button by API name
     * @memberof RecordForm
     * @function
     * @param {String} api_name - Button API name
     * @returns {Button|null} Button object
     * @example <caption>Sample</caption>
     * zdk.components.record_form.button('record_save');
     */
    button(api_name)   { return super.button(api_name); }
    /**
     * @summary Get all buttons in the page
     * @memberof RecordForm
     * @function
     * @returns {Button[]} Array of Button objects
     * @example <caption>Sample</caption>
     * zdk.components.record_form.buttons();
     */
    buttons()          { return super.buttons(); }
    /**
     * @summary Get a field by API name
     * @memberof RecordForm
     * @function
     * @param {String} api_name - Field API name
     * @returns {Field|null} Field object
     * @example <caption>Sample</caption>
     * zdk.components.record_form.field('Last_Name');
     */
    field(api_name)    { return super.field(api_name); }
    /**
     * @summary Get all fields in the page
     * @memberof RecordForm
     * @function
     * @returns {Field[]} Array of Field objects
     * @example <caption>Sample</caption>
     * zdk.components.record_form.fields();
     */
    fields()           { return super.fields(); }
    /**
     * @summary Get a subform by API name
     * @memberof RecordForm
     * @function
     * @param {String} api_name - Subform API name
     * @returns {Subform} Subform object
     * @example <caption>Sample</caption>
     * zdk.components.record_form.subform('CFSubform');
     */
    subform(api_name)  { return super.subform(api_name); }
    /**
     * @summary Get all form field values as a plain object
     * @memberof RecordForm
     * @function
     * @returns {Object} Field api_name → value map
     * @example <caption>Sample</caption>
     * var data = zdk.components.record_form.getValues();
     */
    getValues()        { return super.getValues(); }
    /**
     * @summary Set multiple form field values in one call
     * @memberof RecordForm
     * @function
     * @param {Object} values - Field api_name → value map
     * @returns {Promise} Result of values update
     * @example <caption>Sample</caption>
     * zdk.components.record_form.setValues({ Last_Name: 'Zylker' });
     */
    setValues(values)  { return super.setValues(values); }
    /**
     * @summary Bulk-set field properties across multiple fields in one call
     * @memberof RecordForm
     * @function
     * @param {Object} config - Map of field api_name → property config
     * @returns {Promise} Result of config operation
     * @example <caption>Sample</caption>
     * zdk.components.record_form.config({ Last_Name: { mandate: true } });
     */
    config(config)     { return super.config(config); }
    /**
     * @summary Get page context information
     * @memberof RecordForm
     * @function
     * @returns {Object|Promise} Page info with record_id and parent_record_id
     * @example <caption>Sample</caption>
     * var info = zdk.components.record_form.getInfo();
     * console.log(info.record_id);
     */
    getInfo() {
      var base = super.getInfo();
      var piProm = ZDKResolver({ action: 'page_info', config: { include_module_apiname: true } });
      if (base && typeof base.then === 'function') {
        return Promise.all([base, piProm]).then(function (results) {
          var b = results[0], pi = results[1];
          var record_id = pi && pi.record_id;
          return Object.assign({}, b, { parent_record_id: pi && pi.parent_record_id, record_id: record_id, record: record_id ? { id: record_id } : undefined });
        });
      }
      var record_id = piProm && piProm.record_id;
      return Object.assign({}, base, { parent_record_id: piProm && piProm.parent_record_id, record_id: record_id, record: record_id ? { id: record_id } : undefined });
    }
    /**
     * @summary Get a UI element by ID for Canvas/Wizard interactions
     * @memberof RecordForm
     * @function
     * @param {String} element_id - Element ID
     * @returns {UIElement|null} UIElement object
     * @example <caption>Sample</caption>
     * zdk.components.record_form.ui_element('myElem').display(true);
     */
    ui_element(eid)        { return super.ui_element(eid); }
    /**
     * @summary Get the Page Selection component (for canvas/wizard page tabs)
     * @memberof RecordForm
     * @instance
     * @type {PageSelection}
     * @example <caption>Get current page</caption>
     * zdk.components.record_form.page_selection.getValue();
     * @example <caption>Navigate to page</caption>
     * zdk.components.record_form.page_selection.setValue('page_api_name');
     */
    get page_selection()   { return new PageSelection('root'); }
    /**
     * @summary Get the Layout Selection component
     * @memberof RecordForm
     * @instance
     * @type {LayoutSelection}
     * @example <caption>Get current layout</caption>
     * zdk.components.record_form.layout_selection.getValue();
     * @example <caption>Set layout</caption>
     * zdk.components.record_form.layout_selection.setValue('43125880000000XXXX');
     */
    get layout_selection() { return new LayoutSelection('root'); }
  }

  /**
   * Class representing a Quick Create popup page Instance.
   * @class RecordQuickCreate
   * @category Components
   */
  class RecordQuickCreate extends RecordPageBase {
    static className = 'RecordQuickCreate';
    constructor(module) { super(module); }
    /**
     * @summary Get a button by API name
     * @memberof RecordQuickCreate
     * @function
     * @param {String} api_name - Button API name
     * @returns {Button|null} Button object
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.button('record_save');
     */
    button(api_name) { return super.button(api_name); }
    /**
     * @summary Get all buttons in the quick create popup
     * @memberof RecordQuickCreate
     * @function
     * @returns {Button[]} Array of Button objects
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.buttons();
     */
    buttons()        { return super.buttons(); }
    /**
     * @summary Get a field by API name
     * @memberof RecordQuickCreate
     * @function
     * @param {String} api_name - Field API name
     * @returns {Field|null} Field object
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.field('Email');
     */
    field(api_name) { return new Field(api_name, 'root'); }
    /**
     * @summary Get all fields in the quick create form
     * @memberof RecordQuickCreate
     * @function
     * @returns {Field[]} Array of Field objects
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.fields();
     */
    fields() {
      return _resolveAndMap(
        ZDKResolver({ action: 'form_read' }),
        function (fs) { return Object.keys(fs).map(function (x) { return new Field(x, 'root'); }); }
      );
    }
    /**
     * @summary Get page context information
     * @memberof RecordQuickCreate
     * @function
     * @returns {Object|Promise} Page info object
     * @example <caption>Sample</caption>
     * var info = zdk.components.record_quick_create.getInfo();
     */
    getInfo()    { return super.getInfo(); }
    /**
     * @summary Get the parent component from which this Quick Create popup was opened
     * @memberof RecordQuickCreate
     * @function
     * @returns {RecordForm|RecordDetail|RecordList|Promise} Parent component instance
     * @example <caption>Sample</caption>
     * var parentComponent = zdk.components.record_quick_create.getParentComponent();
     */
    getParentComponent() {
      return _resolveAndMap(
        ZDKResolver({ action: 'get_parent_component' }),
        function (p) {
          var name = p && (p.name || p.component);
          if (name === 'record_form')   { return Object.assign(function (m) { return new RecordForm(m); },   new RecordForm(p && p.module)); }
          if (name === 'record_detail') { return Object.assign(function (m) { return new RecordDetail(m); }, new RecordDetail(p && p.module)); }
          return Object.assign(function (m) { return new RecordList(m); }, new RecordList(p && p.module));
        }
      );
    }
    /**
     * @summary Get a UI element by ID
     * @memberof RecordQuickCreate
     * @function
     * @param {String} element_id - Element ID
     * @returns {UIElement|null} UIElement object
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.ui_element('myElem');
     */
    ui_element(eid) { return super.ui_element(eid); }
    /**
     * @summary Get all form field values as a plain object
     * @memberof RecordQuickCreate
     * @function
     * @returns {Object|Promise} Field api_name → value map
     * @example <caption>Sample</caption>
     * var data = zdk.components.record_quick_create.getValues();
     */
    getValues()     { return ZDKResolver({ action: 'form_read',   selector: 'root' }); }
    /**
     * @summary Set multiple form field values in one call
     * @memberof RecordQuickCreate
     * @function
     * @param {Object} values - Field api_name → value map
     * @returns {Promise} Result of values update
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.setValues({Last_Name: 'Doe', Email: 'doe@example.com'});
     */
    setValues(v)    { return ZDKResolver({ action: 'form_write',  req_data: v, selector: 'root' }); }
    /**
     * @summary Bulk-set field properties across multiple fields in one call
     * @memberof RecordQuickCreate
     * @function
     * @param {Object} config - Map of field api_name → property config
     * @returns {Promise} Result of config operation
     * @example <caption>Sample</caption>
     * zdk.components.record_quick_create.config({Last_Name: {mandate: true}});
     */
    config(c)       { return ZDKResolver({ action: 'form_config', req_data: c, selector: 'root' }); }
    /**
     * @summary Get the Layout Selection component
     * @memberof RecordQuickCreate
     * @instance
     * @type {LayoutSelection}
     * @returns {LayoutSelection} LayoutSelection component instance
     * @example <caption>Get current layout</caption>
     * var layoutId = zdk.components.record_quick_create.layout_selection.getValue();
     */
    get layout_selection() { return new LayoutSelection('root'); }
  }

  /**
   * Class representing a Record Detail page Instance.
   * @class RecordDetail
   * @category Components
   */
  class RecordDetail extends RecordFormPageBase {
    static className = 'RecordDetail';
    constructor(module) { super(module); }
    /**
     * @summary Get a button by API name
     * @memberof RecordDetail
     * @function
     * @param {String} api_name - Button API name
     * @returns {Button|null} Button object
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.button('record_edit');
     */
    button(api_name)  { return super.button(api_name); }
    /**
     * @summary Get all buttons in the detail page
     * @memberof RecordDetail
     * @function
     * @returns {Button[]} Array of Button objects
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.buttons();
     */
    buttons()         { return super.buttons(); }
    /**
     * @summary Get a field by API name
     * @memberof RecordDetail
     * @function
     * @param {String} api_name - Field API name
     * @returns {Field|null} Field object
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.field('Email');
     */
    field(api_name)   { return super.field(api_name); }
    /**
     * @summary Get all fields in the detail page
     * @memberof RecordDetail
     * @function
     * @returns {Field[]} Array of Field objects
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.fields();
     */
    fields()          { return super.fields(); }
    /**
     * @summary Get a subform by API name
     * @memberof RecordDetail
     * @function
     * @param {String} api_name - Subform API name
     * @returns {Subform} Subform object
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.subform('LineItems');
     */
    subform(api_name) { return super.subform(api_name); }
    /**
     * @summary Get all form field values as a plain object
     * @memberof RecordDetail
     * @function
     * @returns {Object} Field api_name → value map
     * @example <caption>Sample</caption>
     * var data = zdk.components.record_detail.getValues();
     */
    getValues()       { return super.getValues(); }
    /**
     * @summary Set multiple form field values in one call
     * @memberof RecordDetail
     * @function
     * @param {Object} values - Field api_name → value map
     * @returns {Promise} Result of values update
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.setValues({Email: 'new@example.com'});
     */
    // setValues(v)      { return super.setValues(v); }
    /**
     * @summary Bulk-set field properties across multiple fields in one call
     * @memberof RecordDetail
     * @function
     * @param {Object} config - Map of field api_name → property config
     * @returns {Promise} Result of config operation
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.config({Email: {display: true, mandate: true}});
     */
    config(c)         { return super.config(c); }
    /**
     * @summary Get page context information including record_id
     * @memberof RecordDetail
     * @function
     * @returns {Object|Promise} Page info with record_id
     * @example <caption>Sample</caption>
     * var info = zdk.components.record_detail.getInfo();
     * console.log(info.record_id);
     */
    getInfo() {
      var base = super.getInfo();
      var piProm = ZDKResolver({ action: 'page_info', config: { include_module_apiname: true } });
      if (base && typeof base.then === 'function') {
        return Promise.all([base, piProm]).then(function (results) {
          var b = results[0], pi = results[1];
          var record_id = pi && pi.record_id;
          return Object.assign({}, b, { record_id: record_id, record: record_id ? { id: record_id } : undefined });
        });
      }
      var record_id = piProm && piProm.record_id;
      return Object.assign({}, base, { record_id: record_id, record: record_id ? { id: record_id } : undefined });
    }
    /**
     * @summary Get all links in the detail page
     * @memberof RecordDetail
     * @function
     * @returns {Link[]|Promise} Array of Link objects
     * @example <caption>Sample</caption>
     * var links = zdk.components.record_detail.links();
     * links[0].click();
     */
    links() {
      return _resolveAndMap(
        ZDKResolver({ action: 'link_list' }),
        function (list) { return list.map(function (x) { return new Link(x.id, x.name, 'root'); }); }
      );
    }
    /**
     * @summary Get blueprint transitions
     * @memberof RecordDetail
     * @function
     * @returns {BlueprintTransition[]|Promise} Array of BlueprintTransition objects
     * @example <caption>Sample</caption>
     * var transitions = zdk.components.record_detail.blueprintTransitions();
     */
    blueprintTransitions() {
      return _resolveAndMap(
        ZDKResolver({ action: 'get_blueprint_transitions' }),
        function (ts) { return ts ? ts.map(function (x) { return new BlueprintTransition(x.id, x.name, 'root'); }) : []; }
      );
    }
    /**
     * @summary Add tags to record
     * @memberof RecordDetail
     * @function
     * @param {...String} tag_names - Names of tags to add
     * @returns {Promise} Result of tag addition
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.addTag('hot-lead', 'vip');
     */
    addTag(...tag_names)    { return ZDKResolver({ action: 'tag_add',    tag_name: Array.from(tag_names).filter(x => typeof x === 'string') }); }
    /**
     * @summary Remove tags from record
     * @memberof RecordDetail
     * @function
     * @param {...String} tag_names - Names of tags to remove
     * @returns {Promise} Result of tag removal
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.removeTag('old-tag');
     */
    removeTag(...tag_names) { return ZDKResolver({ action: 'tag_remove', tag_name: Array.from(tag_names).filter(x => typeof x === 'string') }); }
    /**
     * @summary Get all tags on record
     * @memberof RecordDetail
     * @function
     * @returns {Array|Promise} Array of tag names
     * @example <caption>Sample</caption>
     * var tags = zdk.components.record_detail.getTags();
     * @example <caption>Output</caption>
     * ['hot-lead', 'vip', 'priority']
     */
    getTags()               { return ZDKResolver({ action: 'tag_list' }) || null; }
    /**
     * @summary Get a UI element by ID
     * @memberof RecordDetail
     * @function
     * @param {String} element_id - Element ID
     * @returns {UIElement|null} UIElement object
     * @example <caption>Sample</caption>
     * zdk.components.record_detail.ui_element('myElem').display(true);
     */
    ui_element(eid)         { return super.ui_element(eid); }
    /**
     * @summary Get the Notes Editor component
     * @memberof RecordDetail
     * @instance
     * @type {NotesEditor}
     * @returns {NotesEditor} NotesEditor component instance
     * @example <caption>Get notes</caption>
     * var notes = zdk.components.record_detail.notes_editor.getValue();
     */
    get notes_editor()      { return new NotesEditor('root'); }
    /**
     * @summary Get the Custom View Selection component
     * @memberof RecordDetail
     * @instance
     * @type {CustomViewSelection}
     * @returns {CustomViewSelection} CustomViewSelection component instance
     * @example <caption>Get current view</caption>
     * var viewId = zdk.components.record_detail.custom_view_selection.getValue();
     */
    get custom_view_selection() { return new CustomViewSelection('root'); }
    /**
     * @summary Get the Page Selection component (for canvas/wizard page tabs)
     * @memberof RecordDetail
     * @instance
     * @type {PageSelection}
     * @returns {PageSelection} PageSelection component instance
     * @example <caption>Get current page</caption>
     * var currentPage = zdk.components.record_detail.page_selection.getValue();
     */
    get page_selection()    { return new PageSelection('root'); }
  }

  /**
   * Class representing a Record List page Instance.
   * @class RecordList
   * @category Components
   */
  class RecordList extends RecordPageBase {
    static className = 'RecordList';
    constructor(module) { super(module); }
    /**
     * @summary Get page context information
     * @memberof RecordList
     * @function
     * @returns {Object|Promise} Page info object
     * @example <caption>Sample</caption>
     * var info = zdk.components.record_list.getInfo();
     */
    getInfo()  { return super.getInfo(); }
    /**
     * @summary Get a button by API name
     * @memberof RecordList
     * @function
     * @param {String} api_name - Button API name
     * @returns {Button|null} Button object
     * @example <caption>Sample</caption>
     * zdk.components.record_list.button('record_import');
     */
    button(api_name) { return super.button(api_name); }
    /**
     * @summary Get all buttons in the list page
     * @memberof RecordList
     * @function
     * @returns {Button[]} Array of Button objects
     * @example <caption>Sample</caption>
     * zdk.components.record_list.buttons();
     */
    buttons()        { return super.buttons(); }
    /**
     * @summary Freeze list columns to prevent modification
     * @memberof RecordList
     * @function
     * @param {Boolean} option - true to freeze, false to unfreeze
     * @returns {Promise} Result of freeze operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.freezeColumns(true);
     */
    freezeColumns(option) { return ZDKResolver({ action: 'list_fields_freeze', option: !!option, selector: 'root' }); }
    /**
     * @summary Mask field values in list view
     * @memberof RecordList
     * @function
     * @param {String} field_name - Field API name
     * @param {Object} config - Mask configuration (length, character, reverse)
     * @returns {Promise} Result of mask operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.maskField('Email', {length: 5, character: '*'});
     */
    maskField(field_name, config) {
      if (!config.length || config.length < 1) { throw new Error('invalid length - ' + config.length); }
      return ZDKResolver({ action: 'list_fields_mask', field_name, config, selector: 'root' });
    }
    /**
     * @summary Sort field in list view
     * @memberof RecordList
     * @function
     * @param {String} field_name - Field API name
     * @param {String} option - Sort option (asc, desc, unsort)
     * @returns {Promise} Result of sort operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.sortByField('Last_Name', 'asc');
     */
    sortByField(field_name, option) { return ZDKResolver({ action: 'list_fields_sort',        field_name, option, selector: 'root' }); }
    /**
     * @summary Get records in list view
     * @memberof RecordList
     * @function
     * @returns {Array|Promise} Array of record objects
     * @example <caption>Sample</caption>
     * var records = zdk.components.record_list.getRecords();
     */
    getRecords()        { return ZDKResolver({ action: 'list_records_get',                                         selector: 'root' }); }
    /**
     * @summary Select records by criteria
     * @memberof RecordList
     * @function
     * @param {String} criteria - Selection criteria expression
     * @returns {Promise} Result of selection operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.selectRecords('(Last_Name:Zylker)');
     */
    selectRecords(c)    { return ZDKResolver({ action: 'list_records_select',        criteria: c,                  selector: 'root' }); }
    /**
     * @summary Select records by ID
     * @memberof RecordList
     * @function
     * @param {String[]} ids - Array of record IDs
     * @returns {Promise} Result of selection operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.selectRecordsByID(['123456789', '987654321']);
     */
    selectRecordsByID(ids) {
      if (!Array.isArray(ids)) { throw new TypeError('ids should be an Array'); }
      return ZDKResolver({ action: 'list_records_select_id', ids, selector: 'root' });
    }
    /**
     * @summary Clear selected records
     * @memberof RecordList
     * @function
     * @returns {Promise} Result of clear operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.clearSelection();
     */
    clearSelection()    { return ZDKResolver({ action: 'list_records_clear_selected',                              selector: 'root' }); }
    /**
     * @summary Apply styles to records based on criteria
     * @memberof RecordList
     * @function
     * @param {Object} style_config - Style configuration (record, field)
     * @param {String} criteria - Criteria to match records
     * @returns {Promise} Result of style operation
     * @example <caption>Sample</caption>
     * zdk.components.record_list.style({record: {background: 'red'}}, '(Last_Name:Zylker)');
     */
    style(style_config, criteria) { return ZDKResolver({ action: 'list_records_style', style_config, criteria,    selector: 'root' }); }
    /**
     * @summary Get a UI element by ID
     * @memberof RecordList
     * @function
     * @param {String} element_id - Element ID
     * @returns {UIElement|null} UIElement object
     * @example <caption>Sample</caption>
     * zdk.components.record_list.ui_element('myElem').display(true);
     */
    ui_element(eid)     { return super.ui_element(eid); }
    /**
     * @summary Get the Custom View Selection component
     * @memberof RecordList
     * @instance
     * @type {CustomViewSelection}
     * @returns {CustomViewSelection} CustomViewSelection component instance
     * @example <caption>Sample</caption>
     * var view = zdk.components.record_list.custom_view_selection.getValue();
     */
    get custom_view_selection() { return new CustomViewSelection('root'); }
    /**
     * @summary Get the View Type Selection component
     * @memberof RecordList
     * @instance
     * @type {ViewTypeSelection}
     * @returns {ViewTypeSelection} ViewTypeSelection component instance
     * @example <caption>Sample</caption>
     * var viewType = zdk.components.record_list.view_type_selection.getValue();
     */
    get view_type_selection()   { return new ViewTypeSelection('root'); }
    /**
     * @summary Get the Page Selection component (for canvas/wizard page tabs)
     * @memberof RecordList
     * @instance
     * @type {PageSelection}
     * @returns {PageSelection} PageSelection component instance
     * @example <caption>Sample</caption>
     * var currentPage = zdk.components.record_list.page_selection.getValue();
     */
    get page_selection()        { return new PageSelection('root'); }
    /**
     * @summary Get the Notes Editor component
     * @memberof RecordList
     * @instance
     * @type {NotesEditor}
     * @returns {NotesEditor} NotesEditor component instance
     * @example <caption>Sample</caption>
     * var notes = zdk.components.record_list.notes_editor.getValue();
     */
    get notes_editor()          { return new NotesEditor('root'); }
  }

  // ── UI component classes (Loader, Popup, Flyout, Mailer) ────────────

  class Loader {
    static className = 'Loader';
    /**
     * @summary Show a loading spinner with optional message
     * @function
     * @param {Object} config - Loader configuration
     * @param {String} [config.type] - Type of loader ('page', default)
     * @param {String} [config.template] - Template style ('spinner', 'vertical-bar', 'standard', 'dot-spinner', default 'standard')
     * @param {String} [config.message] - Loading message (max 240 characters)
     * @param {Number} [config.timer] - Auto-hide timer in milliseconds (0-60000)
     * @returns {Promise} Result of show operation
     * @example <caption>Sample</caption>
     * zdk.ui.Loader.show({template: 'spinner', message: 'Loading data...', timer: 3000});
     * @example <caption>Standard loader</caption>
     * zdk.ui.Loader.show({message: 'Processing...'});
     */
    show(config) {
      config = config || {};
      if (config.template === '' || (config.template && !config.template.trim())) { throw new Error('Invalid Loader Template'); }
      config.type     = config.type     || 'page';
      config.template = config.template || 'standard';
      if (!['page'].includes(config.type)) { throw new TypeError('Invalid Loader Type'); }
      if (!['spinner', 'vertical-bar', 'standard', 'dot-spinner'].includes(config.template)) { throw new Error('Invalid Loader Template'); }
      if (config.message && config.message.length > 240) { throw new Error('Loader message must be atmost 240 characters'); }
      if (config.timer !== undefined && config.timer !== null) {
        if (typeof config.timer !== 'number' || isNaN(config.timer) || config.timer < 0) { throw new TypeError('timer must be a positive number'); }
        if (config.timer > 60000) { throw new Error('timer duration limit crossed - ' + config.timer + '. Maximum is 60000ms'); }
      }
      return ZDKResolver({ action: 'show_loader', type: config.type, template: config.template, message: config.message || '', timer: config.timer !== undefined ? config.timer : null }, { loading: config.template !== 'standard' });
    }
    /**
     * @summary Hide the loading spinner
     * @function
     * @returns {Promise} Result of hide operation
     * @example <caption>Sample</caption>
     * zdk.ui.Loader.hide();
     */
    hide() { return ZDKResolver({ action: 'hide_loader' }, { loading: false }); }
  }

  class Popup {
    static className = 'Popup';
    open(widget, config, data) {
      var type = widget.type, api_name = widget.api_name, id = widget.id, crux = widget.crux;
      var widgetConfig = {};
      if (widget && typeof widget === 'object') {
        Object.keys(widget).forEach(function (key) {
          if (!['type', 'api_name', 'id', 'crux'].includes(key)) {
            widgetConfig[key] = widget[key];
          }
        });
      }
      var popupConfig = Object.assign({}, widgetConfig, config || {});
      if (!['widget', 'crux', 'slyteui', 'kiosk'].includes(type)) { throw new Error('unsupported popup type: ' + type); }
      if (type === 'crux' && !['record_create', 'record_edit', 'record_detail', 'record_clone', 'record-picker'].includes(api_name)) {
        throw new Error('unsupported crux type: ' + api_name);
      }
      return ZDKResolver({ action: 'open_popup', id, type, api_name, crux, config: popupConfig, data }, { userInput: true });
    }
    config(config) { return ZDKResolver({ action: 'update_popup_config', config }); }
    close(config, response)  { return WDKCompat.popupClose(config || {}, response || {}); }
  }

  class Flyout {
    static className = 'Flyout';
    #name;
    constructor(name) { this.#name = name; }
    open(widget, config, data) {
      var type = widget && widget.type;
      if (type && !['widget', 'kiosk', 'slyteui'].includes(type)) { throw new Error('unsupported Flyout type: ' + type); }
      return WDKCompat.flyoutOpen(this.#name, widget, config, data);
    }
    close()        { return ZDKResolver({ action: 'close_flyout',         name: this.#name }); }
    config(config) { return ZDKResolver({ action: 'update_flyout_config', name: this.#name, config }); }
    notify(data, options) {
      return ZDKResolver({ action: 'notify_flyout', name: this.#name, data: data, config: options }, { userInput: true });
    }
    sendResponse(request_id, data) {
      return ZDKResolver({ action: 'notify_response', message: { data, uuid: request_id } }, { userInput: true });
    }
  }

  class Mailer {
    static className = 'Mailer';
    open(mail_config) { return ZDKResolver({ action: 'open_mailer', mail_config }); }
  }

  // ── 6. Build the `wdk` namespace ─────────────────────────────────────────────

  // In iframe context ZDKResolver returns a Promise; ?.prop on a Promise gives undefined.
  // This helper chains .then() for the iframe path, or reads the prop directly (CScript).
  function _getUserProp(prop) {
    var p = ZDKResolver({ action: 'variable', key: 'user' });
    if (p && typeof p.then === 'function') { return p.then(function (u) { return u && u[prop]; }); }
    return p && p[prop];
  }

  // ── wdk.user ─────────────────────────────────────────────────────────────────
  /**
   * @namespace wdk.user
   * @summary Logged-in user properties and UI dialog helpers.
   * @description Mirrors the zdk.user surface. Includes `mode` as a WDK host enrichment.
   */
  var wdk_user = {
    get id()          { return _getUserProp('id'); },
    get zuid()        { return _getUserProp('zuid'); },
    get full_name()   { return _getUserProp('full_name'); },
    get first_name()  { return _getUserProp('first_name'); },
    get last_name()   { return _getUserProp('last_name'); },
    get email()       { return _getUserProp('email'); },
    get date_format() { return _getUserProp('date_format'); },
    get role()        { return _getUserProp('role'); },
    get profile()     { return _getUserProp('profile'); },
    get type()        { return _getUserProp('type'); },
    get mode()        { return _getUserProp('mode'); },

    message: function (message, options) {
      if (options && options.duration && (options.duration > 100000 || options.duration < 500)) {
        throw new TypeError('duration should be in range 500 to 100000 ms');
      }
      if (typeof message === 'string' || message instanceof String) {
        return ZDKResolver({ action: 'msg_band', type: (options && options.type) ? options.type : 'info', message, duration: (options && options.duration) ? options.duration : 4000 });
      }
      throw new TypeError('First argument must be a String');
    },

    alert: function (message, accept_message, options) {
      validator(accept_message, 'accept_message', { max_length: 15, min_length: 1, required: false });
      validator(options && options.heading, 'heading', { max_length: 200, min_length: 1, required: false });
      if (options && options.type && !['info', 'error', 'warning', 'success'].includes(options.type)) {
        throw new TypeError('unsupported type : ' + options.type);
      }
      if (typeof message === 'string' || message instanceof String) {
        return ZDKResolver({ action: 'alert', type: (options && options.type) ? options.type : 'info', message, heading: options && options.heading, accept_message }, { userInput: true });
      }
      throw new TypeError('First argument must be a String');
    },

    confirm: function (message, accept_message, reject_message, options) {
      validator(accept_message, 'accept_message', { max_length: 15, min_length: 1, required: false });
      validator(reject_message, 'reject_message', { max_length: 15, min_length: 1, required: false });
      if (options && options.type && !['info', 'error', 'warning', 'success'].includes(options.type)) {
        throw new TypeError('unsupported type : ' + options.type);
      }
      if (typeof message === 'string' || message instanceof String) {
        return ZDKResolver({ action: 'confirm', accept_message, reject_message, acceptMsg: accept_message, rejectMsg: reject_message, heading: (options && options.heading) ? options.heading : '', type: (options && options.type) ? options.type : '', message }, { userInput: true });
      }
      throw new TypeError('First argument must be a String');
    },

    input: function (options, accept_message, reject_message, dialog) {
      if (options) {
        if (!Array.isArray(options)) { throw new TypeError('options should be an array'); }
        if (options.length > 10) { throw new Error('Max input limit of 10 reached'); }
        options.forEach(function (option) {
          var allowed = ['text', 'number', 'textarea', 'picklist', 'multiselectpicklist', 'date', 'dateandtime', 'checkbox', 'radiobutton', 'email', 'dropdown', 'twitter', 'lookup'];
          if (!allowed.includes(option.type)) { throw new TypeError('unsupported field type : ' + option.type); }
          validator(option.label, "'label' in '" + option.type + "' type", { max_length: 30, min_length: 1, required: true });
          if (option.placeholder !== undefined)  { validator(option.placeholder,  'placeholder',  { max_length: 30, required: false }); }
          if (option.info_message !== undefined) { validator(option.info_message, 'info_message', { max_length: 30, required: false, allow_null: true }); }
          if (option.title !== undefined)        { validator(option.title,        'title',        { max_length: 30, required: false, allow_null: true }); }
          if (option.required !== undefined && typeof option.required !== 'boolean') {
            throw new TypeError("'required' must be a boolean");
          }
          if (option.max !== undefined && typeof option.max !== 'number') {
            throw new TypeError("'max' must be a Number");
          }
          if (option.min !== undefined && typeof option.min !== 'number') {
            throw new TypeError("'min' must be a Number");
          }
        });
      }
      var heading = dialog && dialog.heading;
      validator(heading, 'heading', { max_length: 30, min_length: 1, required: false });
      var is_limit = accept_message && accept_message.length > 40;
      if (reject_message && reject_message.length > 40 || is_limit) {
        throw new Error((is_limit ? 'accept_message' : 'reject_message') + ' must be atmost 40 characters');
      }
      return ZDKResolver({ action: 'get_input', options, accept_message, reject_message, heading }, { userInput: true });
    }
  };

  // ── wdk.app ──────────────────────────────────────────────────────────────────
  // AppHandler.js exposes individual variable keys: 'org', 'environment', 'deployment'.
  // There is no 'app_context' aggregate key in the handler — using it returns nothing.
  // Platform is detected locally to match the ZDK-2.0.ts contract when the host
  // does not provide an explicit app context variable for it.
  // wdk.app.user is intentionally absent — use wdk.user.* per ZDK-2.0.ts spec.
  /**
   * @namespace wdk.app
   * @summary Application context accessors and host notification entry point.
   */
  var wdk_app = {
    get org()         { return ZDKResolver({ action: 'variable', key: 'org' }); },
    get environment() { return ZDKResolver({ action: 'variable', key: 'environment' }); },
    get platform() {
      var isMobilePlatform = self && self.mobilePlatform && String(self.mobilePlatform).trim().length > 0;
      if (isMobilePlatform) { return 'mobile_application'; }
      var nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav && (nav.userAgent.includes('wv') || ((new RegExp('iphone|ipad|ipod', 'i')).test(nav.userAgent) && !nav.standalone && !(new RegExp('safari', 'i')).test(nav.userAgent)))) {
        return 'mobile_application';
      }
      if (nav && (new RegExp('iPhone|iPad|iPod|Android|webOS|Opera Mini|BlackBerry|Windows Phone', 'i')).test(nav.userAgent)) {
        return 'mobile';
      }
      return 'web';
    },
    get deployment()  { return ZDKResolver({ action: 'variable', key: 'deployment' }); },
    /**
     * @summary Navigate to a CRM page.
     */
    navigate: function (page, params, target, data) {
      var isSetupPage = typeof page === 'string' && page.trim().toLowerCase() === 'setup';
      if (isSetupPage) {
        validator((params && params.api_name) || '', 'params.api_name', { required: true });
      } else {
        validator((params && params.module) || '', 'params.module', { required: true });
      }
      return ZDKResolver({ action: 'route_navigate', page, params, data, target });
    },
    /**
     * @summary Register host event listeners similar to ZOHO.embeddedApp.on.
     * @description
     * Supported event names:
     * - DialerActive
     * - Dialer (alias of Dial)
     * - Notify
     * - NotifyAndWait
     * - PageLoad
     * - ContextUpdate
     */
    on: function (event, callback) {
      if (!event || typeof event !== 'string' || !event.trim()) {
        throw new TypeError('event must be a non-empty string');
      }
      if (typeof callback !== 'function') {
        throw new TypeError('callback must be a Function');
      }

      event = event.trim();

      // Widget iframe path: Event.Listen is a local array-push inside ZSDKEventManager—
      // no postMessage is ever sent, safe to call at any time before or after SET_CONTEXT.
      if (typeof self._getAppSDK === 'function') {
        return self._getAppSDK().getContext().Event.Listen(event, callback);
      }

      // CScript / generic event bus fallback (no ZSDK instance available)
      return ZDKResolver({
        action: 'event_add_listener',
        eventName: event,
        callback: callback,
        options: { origin: '*' }
      });
    },
    /**
     * @summary Notify host application with an event and optional payload.
     * @description
     * All events are forwarded as `app_notify`.
     * Host-side routing (for example, `blueprint.proceed`, `component.resize`)
     * is handled in WidgetHandler.
     */
    notify: function (event, data) {
      if (!event || typeof event !== 'string' || !event.trim()) {
        throw new TypeError('event must be a non-empty string');
      }
      var normalizedEvent = event.trim();
      return ZDKResolver({ action: 'app_notify', event: normalizedEvent, data: data }, { userInput: true });
    }
  };

  // ── wdk.page ─────────────────────────────────────────────────────────────────
  /**
   * @namespace wdk.page
   * @summary Page context, refresh, and freeze helpers.
   */
  var wdk_page = {
    getNavigationData: function () {
      return ZDKResolver({ action: 'navigation_data' });
    },
    getName: function () {
      return ZDKResolver({ action: 'page_info', config: { include_module_apiname: true } })?.name;
    },
    refresh: function (config) {
      return ZDKResolver({ action: 'refresh_page', config: config || { triggerOnLoad: false } }, { userInput: true });
    },
    freeze: function (flag) {
      return ZDKResolver({ action: flag ? 'freeze' : 'unfreeze' });
    }
  };

  // ── wdk.store helpers ────────────────────────────────────────────────────────

  function _validateCacheKey(key) {
    if (!key || typeof key !== 'string' || !key.trim()) {
      throw new TypeError('key must be a non-empty String');
    }
  }

  function _validateCacheExpiry(expiry) {
    if (expiry === undefined || expiry === null) { return; }
    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
      throw new TypeError('options.expiry must be a number');
    }
    var MIN_EXPIRY = 60000;                      // 1 minute
    var MAX_EXPIRY = 365 * 24 * 60 * 60 * 1000; // 365 days
    if (expiry < MIN_EXPIRY) { throw new RangeError('options.expiry must be at least ' + MIN_EXPIRY + ' ms'); }
    if (expiry > MAX_EXPIRY) { throw new RangeError('options.expiry must be at most '   + MAX_EXPIRY + ' ms'); }
  }

  var _DEFAULT_CACHE_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days

  class _BucketCacheStorage {
    #bucket;
    constructor(bucket) { this.#bucket = bucket; }
    get(key, defaultValue) {
      _validateCacheKey(key);
      return ZDKResolver({ action: 'cache_get', bucket: this.#bucket, key: key, defaultValue: defaultValue });
    }
    set(key, value, options) {
      _validateCacheKey(key);
      var expiry = (options && options.expiry !== undefined) ? options.expiry : _DEFAULT_CACHE_EXPIRY;
      _validateCacheExpiry(expiry);
      return ZDKResolver({ action: 'cache_set', bucket: this.#bucket, key: key, value: value, expiry: expiry });
    }
    remove(key) {
      _validateCacheKey(key);
      return ZDKResolver({ action: 'cache_remove', bucket: this.#bucket, key: key });
    }
    clear() {
      return ZDKResolver({ action: 'cache_clear_bucket', bucket: this.#bucket });
    }
  }

  // ── wdk.store ─────────────────────────────────────────────────────────────────
  //  Callable: wdk.store('bucket') → _BucketCacheStorage (persistent, server-backed)
  //  Direct:   wdk.store.get/set/remove/clear() → sessionStorage (unbucketed)
  //  Note: clear() is intentionally bucket-only (matches zdk.store semantics).
  /**
   * @namespace wdk.store
   * @summary Session storage and bucketed persistent cache helpers.
   */
  function Storage(bucket) {
    if (bucket !== undefined && bucket !== null) {
      if (typeof bucket !== 'string' || !bucket.trim()) {
        throw new TypeError('bucket must be a non-empty String');
      }
      return new _BucketCacheStorage(bucket);
    }
    return {
      get:    function (key)        { return ZDKResolver({ action: 'session_storage_get',    key: key }); },
      set:    function (key, value) { _validateCacheKey(key); return ZDKResolver({ action: 'session_storage_set',    key: key, value: typeof value === 'string' ? value : JSON.stringify(value) }); },
      remove: function (key)        { _validateCacheKey(key); return ZDKResolver({ action: 'session_storage_remove', key: key }); }
    };
  }

  // Patch direct properties so wdk.store.get/set/remove() work without calling wdk.store().
  // Routes through ZDKResolver (session_storage_* actions) in all contexts — CScript and iframe.
  // Note: unbucketed clear() is intentionally absent (not in ZDK spec for unbucketed storage).
  Storage.get    = function (key)        { if (!key || typeof key !== 'string') { return null; } return ZDKResolver({ action: 'session_storage_get',    key: key }); };
  Storage.set    = function (key, value) { _validateCacheKey(key); return ZDKResolver({ action: 'session_storage_set',    key: key, value: typeof value === 'string' ? value : JSON.stringify(value) }); };
  Storage.remove = function (key)        { _validateCacheKey(key); return ZDKResolver({ action: 'session_storage_remove', key: key }); };

  var wdk_store = Storage;

  // ── wdk.event ─────────────────────────────────────────────────────────────────
  /**
   * @namespace wdk.event
   * @summary Event bus helpers for listener registration, removal, and triggering.
   */
  var wdk_event = {
    on: function (eventName, callback, options) {
      // Register via SDK event system — safe before SET_CONTEXT arrives.
      if (typeof self._getAppSDK === 'function') {
        return self._getAppSDK().getContext().Event.Listen(eventName, callback);
      }
      // CScript / ZDK event-bus path
      if (!eventName || typeof eventName !== 'string' || !eventName.trim()) {
        throw new TypeError('eventName must be a non-empty String');
      }
      if (eventName.length > 256) { throw new RangeError('eventName must be at most 256 characters'); }
      if (typeof callback !== 'function') { throw new TypeError('callback must be a Function'); }
      if (!options || !options.origin) { throw new TypeError('options.origin is required'); }
      return ZDKResolver({ action: 'event_add_listener', eventName: eventName, callback: callback, options: options });
    },
    off: function (listenerId) {
      if (!listenerId || typeof listenerId !== 'string' || !listenerId.trim()) {
        throw new TypeError('listenerId must be a non-empty String');
      }
      return ZDKResolver({ action: 'event_remove_listener', listenerId: listenerId });
    },
    trigger: function (eventName, data, options) {
      if (!eventName || typeof eventName !== 'string' || !eventName.trim()) {
        throw new TypeError('eventName must be a non-empty String');
      }
      if (eventName.length > 256) { throw new RangeError('eventName must be at most 256 characters'); }
      if (!options || !options.target) { throw new TypeError('options.target is required'); }
      if (options.timeout !== undefined) {
        if (typeof options.timeout !== 'number' || isNaN(options.timeout)) {
          throw new TypeError('timeout must be a number');
        }
        if (options.timeout < 100 || options.timeout > 30000) {
          throw new RangeError('timeout must be between 100 and 30000 ms');
        }
      }
      return ZDKResolver({ action: 'event_trigger', eventName: eventName, data: data, options: options });
    }
  };

  // ── wdk.client ────────────────────────────────────────────────────────────────
  /**
   * @namespace wdk.client
   * @summary Browser/client utility helpers (url, openURL, download, clipboard, geolocation).
   */
  var wdk_client = {};

  Object.defineProperty(wdk_client, 'url', {
    get: function () { return (self.location && self.location.href) || ''; },
    enumerable: true, configurable: true
  });

  wdk_client.openURL = function (url, target) {
    if (!url || typeof url !== 'string' || !url.trim()) {
      throw new TypeError('url must be a non-empty String');
    }
    if (target && target !== '_blank' && target !== '_self') {
      throw new TypeError("target must be '_blank' or '_self'");
    }
    return ZDKResolver({ action: 'open_window', url, target });

  };

  // wdk_client.downloadFile = function (file_name, source) {
  //   if (!source) {
  //     throw new TypeError('Either Blob or url must be provided');
  //   }
  //   if (!(source instanceof Blob) && typeof source !== 'string') {
  //     throw new TypeError('source must be either Blob or String');
  //   }
  //   if (file_name && typeof file_name !== 'string') {
  //     throw new TypeError('file_name must be a String');
  //   }
  //   // return WDKCompat.clientDownloadFile(file_name, source);
  //   return ZDKResolver({
  //       action: 'download_file', // No i18n
  //       blob: source instanceof Blob ? source : undefined,
  //       url: typeof source === 'string' ? source : undefined,
  //       file_name: file_name,
  //       version: wdk.version
  //     }, { userInput: true });
  // };

  wdk_client.copyToClipboard = function (text) {
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new TypeError('text must be a non-empty String');
    }
    if (text.length > 10000) {
      throw new RangeError('text must be at most 10000 characters');
    }
    return ZDKResolver({ action: 'copy_clipboard', text: text });
  };

  wdk_client.geoLocation = function (options) {
    // AppHandler.js handles 'geolocation' as a variable key, not 'geolocation_get_current'.
    // userInput: true because getCurrentPosition requires a browser permission prompt.
    return ZDKResolver({ action: 'variable', key: 'geolocation' }, { userInput: true });
  };

  wdk_client.getSelectedText = function () {
    return ZDKResolver({ action: 'variable', key: 'selectedValue' });
  };

  wdk_client.isActive = function () {
    return ZDKResolver({ action: 'variable', key: 'is_tab_active' });
  };

  // ── wdk.components ────────────────────────────────────────────────────────────
  var wdk_components = {};

  ['record_form', 'record_detail', 'record_list', 'record_quick_create'].forEach(function (key) {
    var Ctor = key === 'record_form'         ? RecordForm
             : key === 'record_detail'       ? RecordDetail
             : key === 'record_quick_create' ? RecordQuickCreate
             : RecordList;
    Object.defineProperty(wdk_components, key, {
      get: function () {
        var defaultInstance = new Ctor();
        var fn = function (module) { return new Ctor(module); };
        // Object.assign(fn, instance) only copies own enumerable props — prototype methods
        // (field, getInfo, getValues, buttons, etc.) are on the prototype, not own props.
        // Walk the prototype chain and copy all methods/getters onto fn.
        var proto = Ctor.prototype;
        while (proto && proto !== Object.prototype) {
          var names = Object.getOwnPropertyNames(proto);
          for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (name === 'constructor' || fn[name] !== undefined) { continue; }
            var desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc) { continue; }
            if (typeof desc.get === 'function') {
              // Getter property (e.g. page_selection, layout_selection, notes_editor)
              Object.defineProperty(fn, name, {
                get: desc.get.bind(defaultInstance),
                enumerable: desc.enumerable, configurable: true
              });
            } else if (typeof desc.value === 'function') {
              fn[name] = desc.value.bind(defaultInstance);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }
        return fn;
      },
      enumerable: true, configurable: true
    });
  });

  Object.defineProperty(wdk_components, 'loader',  { value: new Loader(),                                   enumerable: true, configurable: true });
  Object.defineProperty(wdk_components, 'popup',   { value: new Popup(),                                    enumerable: true, configurable: true });

  var flyoutFactory = function (name) { return new Flyout(name); };
  flyoutFactory.sendResponse = function (request_id, data) {
    return new Flyout().sendResponse(request_id, data);
  };
  Object.defineProperty(wdk_components, 'flyout', { value: flyoutFactory, enumerable: true, configurable: true });

  Object.defineProperty(wdk_components, 'mailer',  { value: new Mailer(),                                   enumerable: true, configurable: true });

  // ── Assemble wdk ──────────────────────────────────────────────────────────────
  var wdk = {
    version: '1.0',
    user:       wdk_user,
    app:        wdk_app,
    page:       wdk_page,
    client:     wdk_client,
    components: wdk_components
    // on: function (eventName, fn) {
    //   return wdk_event.on(eventName, fn);
    // }
  };

  // Optional lazy getters for add-on SDKs
  Object.defineProperty(wdk, 'connector', {
    get: function () {
      if (typeof ZOHO !== 'undefined' && ZOHO.CRM && ZOHO.CRM.CONNECTOR) { return ZOHO.CRM.CONNECTOR; }
      throw new Error('wdk.connector requires ConnectorHelper.js to be loaded after WDK.js.');
    },
    configurable: true, enumerable: false
  });

  global.wdk = wdk;

})(typeof self !== 'undefined' ? self : window);
