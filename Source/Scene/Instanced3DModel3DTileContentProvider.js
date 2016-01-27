/*global define*/
define([
        '../Core/Cartesian3',
        '../Core/Color',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/Ellipsoid',
        '../Core/getAbsoluteUri',
        '../Core/getMagic',
        '../Core/getStringFromTypedArray',
        '../Core/loadArrayBuffer',
        '../Core/Matrix4',
        '../Core/Request',
        '../Core/RequestScheduler',
        '../Core/RequestType',
        '../Core/Transforms',
        '../ThirdParty/Uri',
        '../ThirdParty/when',
        './Cesium3DTileFeature',
        './Cesium3DTileBatchTableResources',
        './Cesium3DTileContentState',
        './ModelInstanceCollection'
    ], function(
        Cartesian3,
        Color,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        DeveloperError,
        Ellipsoid,
        getAbsoluteUri,
        getMagic,
        getStringFromTypedArray,
        loadArrayBuffer,
        Matrix4,
        Request,
        RequestScheduler,
        RequestType,
        Transforms,
        Uri,
        when,
        Cesium3DTileFeature,
        Cesium3DTileBatchTableResources,
        Cesium3DTileContentState,
        ModelInstanceCollection) {
    "use strict";

    /**
     * Represents the contents of a
     * {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/blob/master/TileFormats/Instanced3DModel/README.md|Instanced 3D Model}
     * tile in a {@link https://github.com/AnalyticalGraphicsInc/3d-tiles/blob/master/README.md|3D Tiles} tileset.
     * <p>
     * Use this to access and modify individual features (instances) in the tile.
     * </p>
     * <p>
     * Do not construct this directly.  Access it through {@link Cesium3DTile#content}.
     * </p>
     *
     * @alias Instanced3DModel3DTileContentProvider
     * @constructor
     */
    function Instanced3DModel3DTileContentProvider(tileset, tile, url) {
        this._modelInstanceCollection = undefined;
        this._url = url;
        this._tileset = tileset;
        this._tile = tile;

        /**
         * Part of the {@link Cesium3DTileContentProvider} interface.
         *
         * @private
         */
        this.state = Cesium3DTileContentState.UNLOADED;

        /**
         * Part of the {@link Cesium3DTileContentProvider} interface.
         *
         * @private
         */
        this.processingPromise = when.defer();

        /**
         * Part of the {@link Cesium3DTileContentProvider} interface.
         *
         * @private
         */
        this.readyPromise = when.defer();

        this._batchTableResources = undefined;
        this._features = undefined;
    }

    defineProperties(Instanced3DModel3DTileContentProvider.prototype, {
        /**
         * Gets the number of features in the tile, i.e., the number of 3D models instances.
         *
         * @memberof Instanced3DModel3DTileContentProvider.prototype
         *
         * @type {Number}
         * @readonly
         */
        featuresLength : {
            get : function() {
                return this._modelInstanceCollection.length;
            }
        }
    });

    function createFeatures(content) {
        var tileset = content._tileset;
        var featuresLength = content.featuresLength;
        if (!defined(content._features) && (featuresLength > 0)) {
            var features = new Array(featuresLength);
            for (var i = 0; i < featuresLength; ++i) {
                features[i] = new Cesium3DTileFeature(tileset, content._batchTableResources, i);
            }
            content._features = features;
        }
    }

    /**
     * Determines if the tile's batch table has a property.  If it does, each feature in
     * the tile will have the property.
     *
     * @param {String} name The case-sensitive name of the property.
     * @returns {Boolean} <code>true</code> if the property exists; otherwise, <code>false</code>.
     */
    Instanced3DModel3DTileContentProvider.prototype.hasProperty = function(name) {
        return this._batchTableResources.hasProperty(name);
    };

    /**
     * Returns the {@link Cesium3DTileFeature} object for the feature with the
     * given <code>batchId</code>.  This object is used to get and modify the
     * feature's properties.
     *
     * @param {Number} batchId The batchId for the feature.
     * @returns {Cesium3DTileFeature} The corresponding {@link Cesium3DTileFeature} object.
     *
     * @exception {DeveloperError} batchId must be between zero and {@link Instanced3DModel3DTileContentProvider#featuresLength - 1}.
     */
    Instanced3DModel3DTileContentProvider.prototype.getFeature = function(batchId) {
        var featuresLength = this._modelInstanceCollection.length;
        //>>includeStart('debug', pragmas.debug);
        if (!defined(batchId) || (batchId < 0) || (batchId >= featuresLength)) {
            throw new DeveloperError('batchId is required and between zero and featuresLength - 1 (' + (featuresLength - 1) + ').');
        }
        //>>includeEnd('debug');

        createFeatures(this);
        return this._features[batchId];
    };

    var sizeOfUint16 = Uint16Array.BYTES_PER_ELEMENT;
    var sizeOfUint32 = Uint32Array.BYTES_PER_ELEMENT;
    var sizeOfFloat64 = Float64Array.BYTES_PER_ELEMENT;

    /**
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.request = function() {
        var that = this;

        var distance = this._tile.distanceToCamera;
        var promise = RequestScheduler.schedule(new Request({
            url : this._url,
            server : this._tile.requestServer,
            requestFunction : loadArrayBuffer,
            type : RequestType.TILES3D,
            distance : distance
        }));
        if (defined(promise)) {
            this.state = Cesium3DTileContentState.LOADING;
            promise.then(function(arrayBuffer) {
                if (that.isDestroyed()) {
                    return when.reject('tileset is destroyed');
                }
                that.initialize(arrayBuffer);
            }).otherwise(function(error) {
                that.state = Cesium3DTileContentState.FAILED;
                that.readyPromise.reject(error);
            });
        }
    };

    /**
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.initialize = function(arrayBuffer, byteOffset) {
        byteOffset = defaultValue(byteOffset, 0);

        var uint8Array = new Uint8Array(arrayBuffer);
        var magic = getMagic(uint8Array, byteOffset);
        if (magic !== 'i3dm') {
            throw new DeveloperError('Invalid Instanced 3D Model. Expected magic=i3dm. Read magic=' + magic);
        }

        var view = new DataView(arrayBuffer);
        byteOffset += sizeOfUint32;  // Skip magic number

        //>>includeStart('debug', pragmas.debug);
        var version = view.getUint32(byteOffset, true);
        if (version !== 1) {
            throw new DeveloperError('Only Instanced 3D Model version 1 is supported. Version ' + version + ' is not.');
        }
        //>>includeEnd('debug');
        byteOffset += sizeOfUint32;

        // Skip byteLength
        byteOffset += sizeOfUint32;

        var batchTableByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var gltfByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var gltfFormat = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var instancesLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        //>>includeStart('debug', pragmas.debug);
        if ((gltfFormat !== 0) && (gltfFormat !== 1)) {
            throw new DeveloperError('Only glTF format 0 (uri) or 1 (embedded) are supported. Format ' + gltfFormat + ' is not');
        }
        //>>includeEnd('debug');

        var batchTableResources = new Cesium3DTileBatchTableResources(this, instancesLength);
        this._batchTableResources = batchTableResources;
        var hasBatchTable = false;
        if (batchTableByteLength > 0) {
            hasBatchTable = true;
            var batchTableString = getStringFromTypedArray(uint8Array, byteOffset, batchTableByteLength);
            batchTableResources.batchTable = JSON.parse(batchTableString);
            byteOffset += batchTableByteLength;
        }

        var gltfView = new Uint8Array(arrayBuffer, byteOffset, gltfByteLength);
        byteOffset += gltfByteLength;

        // Each vertex has a longitude, latitude, and optionally batchId if there is a batch table
        // Coordinates are in double precision, batchId is a short
        var instanceByteLength = sizeOfFloat64 * 2 + (hasBatchTable ? sizeOfUint16 : 0);
        var instancesByteLength = instancesLength * instanceByteLength;

        var instancesView = new DataView(arrayBuffer, byteOffset, instancesByteLength);
        byteOffset += instancesByteLength;

        // Create model instance collection
        var collectionOptions = {
            instances : new Array(instancesLength),
            batchTableResources : batchTableResources,
            boundingVolume : this._tile.contentBoundingVolume.boundingVolume,
            cull : false,
            url : undefined,
            headers : undefined,
            type : RequestType.TILES3D,
            gltf : undefined,
            basePath : undefined
        };

        if (gltfFormat === 0) {
            var gltfUrl = getStringFromTypedArray(gltfView);
            collectionOptions.url = getAbsoluteUri(gltfUrl, this._tileset.baseUrl);
        } else {
            collectionOptions.gltf = gltfView;
            collectionOptions.basePath = this._url;
        }

        var ellipsoid = Ellipsoid.WGS84;
        var position = new Cartesian3();
        var instances = collectionOptions.instances;
        byteOffset = 0;

        for (var i = 0; i < instancesLength; ++i) {
            // Get longitude and latitude
            var longitude = instancesView.getFloat64(byteOffset, true);
            byteOffset += sizeOfFloat64;
            var latitude = instancesView.getFloat64(byteOffset, true);
            byteOffset += sizeOfFloat64;
            var height = 0.0;

            // Get batch id. If there is no batch table, the batch id is the array index.
            var batchId = i;
            if (hasBatchTable) {
                batchId = instancesView.getUint16(byteOffset, true);
                byteOffset += sizeOfUint16;
            }

            Cartesian3.fromRadians(longitude, latitude, height, ellipsoid, position);
            var modelMatrix = Transforms.eastNorthUpToFixedFrame(position);

            instances[i] = {
                modelMatrix : modelMatrix,
                batchId : batchId
            };
        }

        var modelInstanceCollection = new ModelInstanceCollection(collectionOptions);
        this._modelInstanceCollection = modelInstanceCollection;
        this.state = Cesium3DTileContentState.PROCESSING;
        this.processingPromise.resolve(this);

        var that = this;

        when(modelInstanceCollection.readyPromise).then(function(modelInstanceCollection) {
            that.state = Cesium3DTileContentState.READY;
            that.readyPromise.resolve(that);
        }).otherwise(function(error) {
            that.state = Cesium3DTileContentState.FAILED;
            that.readyPromise.reject(error);
        });
    };

    /**
     * DOC_TBA
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.applyDebugSettings = function(enabled, color) {
        color = enabled ? color : Color.WHITE;
        this._batchTableResources.setAllColor(color);
    };

    /**
     * DOC_TBA
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.update = function(tiles3D, frameState) {
        // In the PROCESSING state we may be calling update() to move forward
        // the content's resource loading.  In the READY state, it will
        // actually generate commands.
        this._batchTableResources.update(tiles3D, frameState);
        this._modelInstanceCollection.update(frameState);
    };

    /**
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContentProvider} interface.
     *
     * @private
     */
    Instanced3DModel3DTileContentProvider.prototype.destroy = function() {
        this._modelInstanceCollection = this._modelInstanceCollection && this._modelInstanceCollection.destroy();
        this._batchTableResources = this._batchTableResources && this._batchTableResources.destroy();

        return destroyObject(this);
    };
    return Instanced3DModel3DTileContentProvider;
});
