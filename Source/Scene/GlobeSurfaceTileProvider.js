/*global define*/
define([
        '../Core/BoundingSphere',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/FeatureDetection',
        '../Core/GeometryPipeline',
        '../Core/Intersect',
        '../Core/IndexDatatype',
        '../Core/Matrix4',
        '../Core/PrimitiveType',
        '../Core/Rectangle',
        '../Core/TerrainProvider',
        '../Core/WebMercatorProjection',
        '../Renderer/BufferUsage',
        '../Renderer/DrawCommand',
        '../Scene/Pass',
        '../ThirdParty/when',
        './GlobeSurfaceTile',
        './ImageryLayer',
        './ImageryState',
        './QuadtreeTileState',
        './SceneMode'
    ], function(
        BoundingSphere,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        defined,
        defineProperties,
        DeveloperError,
        Event,
        FeatureDetection,
        GeometryPipeline,
        Intersect,
        IndexDatatype,
        Matrix4,
        PrimitiveType,
        Rectangle,
        TerrainProvider,
        WebMercatorProjection,
        BufferUsage,
        DrawCommand,
        Pass,
        when,
        GlobeSurfaceTile,
        ImageryLayer,
        ImageryState,
        QuadtreeTileState,
        SceneMode) {
    "use strict";

    /**
     * Provides general quadtree tiles to be displayed on or near the surface of an ellipsoid.  This type describes an
     * interface and is not intended to be instantiated directly.
     *
     * @alias GlobeSurfaceTileProvider
     * @constructor
     *
     * @private
     */
    var GlobeSurfaceTileProvider = function GlobeSurfaceTileProvider(options) {
        this.lightingFadeOutDistance = 6500000.0;
        this.lightingFadeInDistance = 9000000.0;
        this.oceanNormalMap = undefined;
        this.zoomedOutOceanSpecularIntensity = 0.5;

        this._quadtree = undefined;
        this._terrainProvider = options.terrainProvider;
        this._imageryLayers = options.imageryLayers;
        this._surfaceShaderSet = options.surfaceShaderSet;
        this._renderState = undefined;

        this._errorEvent = new Event();

        this._imageryLayers.layerAdded.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerAdded, this);
        this._imageryLayers.layerRemoved.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerRemoved, this);
        this._imageryLayers.layerMoved.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerMoved, this);
        this._imageryLayers.layerShownOrHidden.addEventListener(GlobeSurfaceTileProvider.prototype._onLayerShownOrHidden, this);

        this._layerOrderChanged = false;

        this._tilesToRenderByTextureCount = [];
        this._drawCommands = [];
        this._uniformMaps = [];
        this._usedDrawCommands = 0;

        this._debug = {
            wireframe : false,
            boundingSphereTile : undefined
        };
    };

    defineProperties(GlobeSurfaceTileProvider.prototype, {
        /**
         * Gets or sets the {@link QuadtreePrimitive} for which this provider is
         * providing tiles.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {QuadtreePrimitive}
         */
        quadtree : {
            get : function() {
                return this._quadtree;
            },
            set : function(value) {
                //>>includeStart('debug', pragmas.debug);
                if (!defined(value)) {
                    throw new DeveloperError('value is required.');
                }

                this._quadtree = value;
            }
        },

        /**
         * Gets a value indicating whether or not the provider is ready for use.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Boolean}
         */
        ready : {
            get : function() {
                return this._terrainProvider.ready && (this._imageryLayers.length === 0 || this._imageryLayers.get(0).imageryProvider.ready);
            }
        },

        /**
         * Gets the tiling scheme used by the provider.  This function should
         * not be called before {@link GlobeSurfaceTileProvider#ready} returns true.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {TilingScheme}
         */
        tilingScheme : {
            get : function() {
                return this._terrainProvider.tilingScheme;
            }
        },

        /**
         * Gets an event that is raised when the geometry provider encounters an asynchronous error.  By subscribing
         * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
         * are passed an instance of {@link TileProviderError}.
         * @memberof GlobeSurfaceTileProvider.prototype
         * @type {Event}
         */
        errorEvent : {
            get : function() {
                return this._errorEvent;
            }
        },

        terrainProvider : {
            get : function() {
                return this._terrainProvider;
            },
            set : function(terrainProvider) {
                if (this._terrainProvider === terrainProvider) {
                    return;
                }

                //>>includeStart('debug', pragmas.debug);
                if (!defined(terrainProvider)) {
                    throw new DeveloperError('terrainProvider is required.');
                }
                //>>includeEnd('debug');

                this._terrainProvider = terrainProvider;

                if (defined(this._quadtree)) {
                    this._quadtree.invalidateAllTiles();
                }
            }
        }
    });

    GlobeSurfaceTileProvider.prototype.beginFrame = function(context, frameState, commandList) {
        function sortTileImageryByLayerIndex(a, b) {
            var aImagery = a.loadingImagery;
            if (!defined(aImagery)) {
                aImagery = a.readyImagery;
            }

            var bImagery = b.loadingImagery;
            if (!defined(bImagery)) {
                bImagery = b.readyImagery;
            }

            return aImagery.imageryLayer._layerIndex - bImagery.imageryLayer._layerIndex;
        }

        this._imageryLayers._update();

        if (this._layerOrderChanged) {
            this._layerOrderChanged = false;

            // Sort the TileImagery instances in each tile by the layer index.
            this._quadtree.forEachLoadedTile(function(tile) {
                tile.data.imagery.sort(sortTileImageryByLayerIndex);
            });
        }

        var tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
        for (var i = 0, len = tilesToRenderByTextureCount.length; i < len; ++i) {
            var tiles = tilesToRenderByTextureCount[i];
            if (defined(tiles)) {
                tiles.length = 0;
            }
        }

        this._usedDrawCommands = 0;
    };

    GlobeSurfaceTileProvider.prototype.endFrame = function(context, frameState, commandList) {
        // And the tile render commands to the command list, sorted by texture count.
        var tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
        for (var textureCountIndex = 0, textureCountLength = tilesToRenderByTextureCount.length; textureCountIndex < textureCountLength; ++textureCountIndex) {
            var tilesToRender = tilesToRenderByTextureCount[textureCountIndex];
            if (!defined(tilesToRender)) {
                continue;
            }

            for (var tileIndex = 0, tileLength = tilesToRender.length; tileIndex < tileLength; ++tileIndex) {
                commandList.push(tilesToRender[tileIndex]);
            }
        }
    };

    /**
     * Gets the maximum geometric error allowed in a tile at a given level.  This function should not be
     * called before {@link GlobeSurfaceTileProvider#ready} returns true.
     * @memberof GlobeSurfaceTileProvider
     *
     * @param {Number} level The tile level for which to get the maximum geometric error.
     * @returns {Number} The maximum geometric error.
     */
    GlobeSurfaceTileProvider.prototype.getLevelMaximumGeometricError = function(level) {
        return this._terrainProvider.getLevelMaximumGeometricError(level);
    };

    /**
     * Loads, or continues loading, a given tile.  This function will continue to be called
     * until {@link QuadtreeTile#state} is no longer {@link QuadtreeTileState#LOADING}.  This function should
     * not be called before {@link GlobeSurfaceTileProvider#ready} returns true.
     *
     * @memberof GlobeSurfaceTileProvider
     *
     * @param {Context} context The rendering context.
     * @param {FrameState} frameState The frame state.
     * @param {QuadtreeTile} tile The tile to load.
     *
     * @exception {DeveloperError} <code>loadTile</code> must not be called before the tile provider is ready.
     */
    GlobeSurfaceTileProvider.prototype.loadTile = function(context, frameState, tile) {
        if (!defined(tile.data)) {
            tile.data = new GlobeSurfaceTile();
        }

        GlobeSurfaceTile.processStateMachine(tile, context, this._terrainProvider, this._imageryLayers);
    };

    var boundingSphereScratch = new BoundingSphere();

    /**
     * Returns true if the tile is visible.  Tiles that are both visible and renderable will be rendered by a call to
     * {@link GlobeSurfaceTileProvider#renderTile}
     *
     * @memberof GlobeSurfaceTileProvider
     *
     * @param {QuadtreeTile} tile The tile instance.
     * @param {FrameState} frameState The state information about the current frame.
     * @param {QuadtreeOccluders} occluders The objects that may occlude this tile.
     *
     * @returns {Boolean} true if the tile is visible; otherwise, false.
     */
    GlobeSurfaceTileProvider.prototype.isTileVisible = function(tile, frameState, occluders) {
        var surfaceTile = tile.data;

        var cullingVolume = frameState.cullingVolume;

        var boundingVolume = surfaceTile.boundingSphere3D;

        if (frameState.mode !== SceneMode.SCENE3D) {
            boundingVolume = boundingSphereScratch;
            BoundingSphere.fromRectangleWithHeights2D(tile.rectangle, frameState.scene2D.projection, surfaceTile.minimumHeight, surfaceTile.maximumHeight, boundingVolume);
            Cartesian3.fromElements(boundingVolume.center.z, boundingVolume.center.x, boundingVolume.center.y, boundingVolume.center);

            if (frameState.mode === SceneMode.MORPHING) {
                boundingVolume = BoundingSphere.union(surfaceTile.boundingSphere3D, boundingVolume, boundingVolume);
            }
        }

        if (cullingVolume.getVisibility(boundingVolume) === Intersect.OUTSIDE) {
            return false;
        }

        if (frameState.mode === SceneMode.SCENE3D) {
            var occludeePointInScaledSpace = surfaceTile.occludeePointInScaledSpace;
            if (!defined(occludeePointInScaledSpace)) {
                return true;
            }

            return occluders.ellipsoid.isScaledSpacePointVisible(occludeePointInScaledSpace);
        }

        return true;
    };

    var float32ArrayScratch = FeatureDetection.supportsTypedArrays() ? new Float32Array(1) : undefined;
    var modifiedModelViewScratch = new Matrix4();
    var tileRectangleScratch = new Cartesian4();
    var rtcScratch = new Cartesian3();
    var centerEyeScratch = new Cartesian4();
    var southwestScratch = new Cartesian3();
    var northeastScratch = new Cartesian3();

    /**
     * Renders a given tile.
     *
     * @memberof GlobeSurfaceTileProvider
     *
     * @param {Object} tile The tile instance.
     * @param {Context} context The rendering context.
     * @param {FrameState} frameState The state information of the current rendering frame.
     * @param {DrawCommand[]} commandList The list of rendering commands.  This method may add additional commands to this list.
     */
    GlobeSurfaceTileProvider.prototype.renderTile = function(tile, context, frameState, commandList) {
        if (!defined(this._renderState)) {
            this._renderState = context.createRenderState({ // Write color and depth
                cull : {
                    enabled : true
                },
                depthTest : {
                    enabled : true
                }
            });
        }

        var surfaceTile = tile.data;

        var viewMatrix = frameState.camera.viewMatrix;
        var maxTextures = context.maximumTextureImageUnits;

        var rtc = surfaceTile.center;

        // Not used in 3D.
        var tileRectangle = tileRectangleScratch;

        // Only used for Mercator projections.
        var southLatitude = 0.0;
        var northLatitude = 0.0;
        var southMercatorYHigh = 0.0;
        var southMercatorYLow = 0.0;
        var oneOverMercatorHeight = 0.0;

        if (frameState.mode !== SceneMode.SCENE3D) {
            var projection = frameState.scene2D.projection;
            var southwest = projection.project(Rectangle.getSouthwest(tile.rectangle), southwestScratch);
            var northeast = projection.project(Rectangle.getNortheast(tile.rectangle), northeastScratch);

            tileRectangle.x = southwest.x;
            tileRectangle.y = southwest.y;
            tileRectangle.z = northeast.x;
            tileRectangle.w = northeast.y;

            // In 2D and Columbus View, use the center of the tile for RTC rendering.
            if (frameState.mode !== SceneMode.MORPHING) {
                rtc = rtcScratch;
                rtc.x = 0.0;
                rtc.y = (tileRectangle.z + tileRectangle.x) * 0.5;
                rtc.z = (tileRectangle.w + tileRectangle.y) * 0.5;
                tileRectangle.x -= rtc.y;
                tileRectangle.y -= rtc.z;
                tileRectangle.z -= rtc.y;
                tileRectangle.w -= rtc.z;
            }

            if (projection instanceof WebMercatorProjection) {
                southLatitude = tile.rectangle.south;
                northLatitude = tile.rectangle.north;

                var southMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(southLatitude);
                var northMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(northLatitude);

                float32ArrayScratch[0] = southMercatorY;
                southMercatorYHigh = float32ArrayScratch[0];
                southMercatorYLow = southMercatorY - float32ArrayScratch[0];

                oneOverMercatorHeight = 1.0 / (northMercatorY - southMercatorY);
            }
        }

        var centerEye = centerEyeScratch;
        centerEye.x = rtc.x;
        centerEye.y = rtc.y;
        centerEye.z = rtc.z;
        centerEye.w = 1.0;

        Matrix4.multiplyByVector(viewMatrix, centerEye, centerEye);
        Matrix4.setColumn(viewMatrix, 3, centerEye, modifiedModelViewScratch);

        var tileImageryCollection = surfaceTile.imagery;
        var imageryIndex = 0;
        var imageryLen = tileImageryCollection.length;

        do {
            var numberOfDayTextures = 0;

            var command;
            var uniformMap;

            if (this._drawCommands.length <= this._usedDrawCommands) {
                command = new DrawCommand();
                command.owner = tile;
                command.cull = false;
                command.boundingVolume = new BoundingSphere();

                uniformMap = createTileUniformMap();

                this._drawCommands.push(command);
                this._uniformMaps.push(uniformMap);
            } else {
                command = this._drawCommands[this._usedDrawCommands];
                uniformMap = this._uniformMaps[this._usedDrawCommands];
            }

            command.owner = tile;

            ++this._usedDrawCommands;

            command.debugShowBoundingVolume = (tile === this._debug.boundingSphereTile);

            uniformMap.oceanNormalMap = this.oceanNormalMap;
            uniformMap.lightingFadeDistance.x = this.lightingFadeOutDistance;
            uniformMap.lightingFadeDistance.y = this.lightingFadeInDistance;
            uniformMap.zoomedOutOceanSpecularIntensity = this.zoomedOutOceanSpecularIntensity;

            uniformMap.center3D = surfaceTile.center;

            Cartesian4.clone(tileRectangle, uniformMap.tileRectangle);
            uniformMap.southAndNorthLatitude.x = southLatitude;
            uniformMap.southAndNorthLatitude.y = northLatitude;
            uniformMap.southMercatorYLowAndHighAndOneOverHeight.x = southMercatorYLow;
            uniformMap.southMercatorYLowAndHighAndOneOverHeight.y = southMercatorYHigh;
            uniformMap.southMercatorYLowAndHighAndOneOverHeight.z = oneOverMercatorHeight;
            Matrix4.clone(modifiedModelViewScratch, uniformMap.modifiedModelView);

            var applyBrightness = false;
            var applyContrast = false;
            var applyHue = false;
            var applySaturation = false;
            var applyGamma = false;
            var applyAlpha = false;

            while (numberOfDayTextures < maxTextures && imageryIndex < imageryLen) {
                var tileImagery = tileImageryCollection[imageryIndex];
                var imagery = tileImagery.readyImagery;
                ++imageryIndex;

                if (!defined(imagery) || imagery.state !== ImageryState.READY || imagery.imageryLayer.alpha === 0.0) {
                    continue;
                }

                var imageryLayer = imagery.imageryLayer;

                if (!defined(tileImagery.textureTranslationAndScale)) {
                    tileImagery.textureTranslationAndScale = imageryLayer._calculateTextureTranslationAndScale(tile, tileImagery);
                }

                uniformMap.dayTextures[numberOfDayTextures] = imagery.texture;
                uniformMap.dayTextureTranslationAndScale[numberOfDayTextures] = tileImagery.textureTranslationAndScale;
                uniformMap.dayTextureTexCoordsRectangle[numberOfDayTextures] = tileImagery.textureCoordinateRectangle;

                if (typeof imageryLayer.alpha === 'function') {
                    uniformMap.dayTextureAlpha[numberOfDayTextures] = imageryLayer.alpha(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureAlpha[numberOfDayTextures] = imageryLayer.alpha;
                }
                applyAlpha = applyAlpha || uniformMap.dayTextureAlpha[numberOfDayTextures] !== 1.0;

                if (typeof imageryLayer.brightness === 'function') {
                    uniformMap.dayTextureBrightness[numberOfDayTextures] = imageryLayer.brightness(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureBrightness[numberOfDayTextures] = imageryLayer.brightness;
                }
                applyBrightness = applyBrightness || uniformMap.dayTextureBrightness[numberOfDayTextures] !== ImageryLayer.DEFAULT_BRIGHTNESS;

                if (typeof imageryLayer.contrast === 'function') {
                    uniformMap.dayTextureContrast[numberOfDayTextures] = imageryLayer.contrast(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureContrast[numberOfDayTextures] = imageryLayer.contrast;
                }
                applyContrast = applyContrast || uniformMap.dayTextureContrast[numberOfDayTextures] !== ImageryLayer.DEFAULT_CONTRAST;

                if (typeof imageryLayer.hue === 'function') {
                    uniformMap.dayTextureHue[numberOfDayTextures] = imageryLayer.hue(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureHue[numberOfDayTextures] = imageryLayer.hue;
                }
                applyHue = applyHue || uniformMap.dayTextureHue[numberOfDayTextures] !== ImageryLayer.DEFAULT_HUE;

                if (typeof imageryLayer.saturation === 'function') {
                    uniformMap.dayTextureSaturation[numberOfDayTextures] = imageryLayer.saturation(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureSaturation[numberOfDayTextures] = imageryLayer.saturation;
                }
                applySaturation = applySaturation || uniformMap.dayTextureSaturation[numberOfDayTextures] !== ImageryLayer.DEFAULT_SATURATION;

                if (typeof imageryLayer.gamma === 'function') {
                    uniformMap.dayTextureOneOverGamma[numberOfDayTextures] = 1.0 / imageryLayer.gamma(frameState, imageryLayer, imagery.x, imagery.y, imagery.level);
                } else {
                    uniformMap.dayTextureOneOverGamma[numberOfDayTextures] = 1.0 / imageryLayer.gamma;
                }
                applyGamma = applyGamma || uniformMap.dayTextureOneOverGamma[numberOfDayTextures] !== 1.0 / ImageryLayer.DEFAULT_GAMMA;

                if (defined(imagery.credits)) {
                    var creditDisplay = frameState.creditDisplay;
                    var credits = imagery.credits;
                    for (var creditIndex = 0, creditLength = credits.length; creditIndex < creditLength; ++creditIndex) {
                        creditDisplay.addCredit(credits[creditIndex]);
                    }
                }

                ++numberOfDayTextures;
            }

            // trim texture array to the used length so we don't end up using old textures
            // which might get destroyed eventually
            uniformMap.dayTextures.length = numberOfDayTextures;
            uniformMap.waterMask = surfaceTile.waterMaskTexture;
            Cartesian4.clone(surfaceTile.waterMaskTranslationAndScale, uniformMap.waterMaskTranslationAndScale);

            command.shaderProgram = this._surfaceShaderSet.getShaderProgram(context, numberOfDayTextures, applyBrightness, applyContrast, applyHue, applySaturation, applyGamma, applyAlpha);
            command.renderState = this._renderState;
            command.primitiveType = PrimitiveType.TRIANGLES;
            command.vertexArray = surfaceTile.vertexArray;
            command.uniformMap = uniformMap;
            command.pass = Pass.OPAQUE;

            if (!defined(this._tilesToRenderByTextureCount[numberOfDayTextures])) {
                this._tilesToRenderByTextureCount[numberOfDayTextures] = [];
            }
            this._tilesToRenderByTextureCount[numberOfDayTextures].push(command);

            // TODO
            if (this._debug.wireframe) {
                createWireframeVertexArrayIfNecessary(context, this, tile);
                if (defined(surfaceTile.wireframeVertexArray)) {
                    command.vertexArray = surfaceTile.wireframeVertexArray;
                    command.primitiveType = PrimitiveType.LINES;
                }
            }

            var boundingVolume = command.boundingVolume;

            if (frameState.mode !== SceneMode.SCENE3D) {
                BoundingSphere.fromRectangleWithHeights2D(tile.rectangle, frameState.scene2D.projection, surfaceTile.minimumHeight, surfaceTile.maximumHeight, boundingVolume);
                Cartesian3.fromElements(boundingVolume.center.z, boundingVolume.center.x, boundingVolume.center.y, boundingVolume.center);

                if (frameState.mode === SceneMode.MORPHING) {
                    boundingVolume = BoundingSphere.union(surfaceTile.boundingSphere3D, boundingVolume, boundingVolume);
                }
            } else {
                BoundingSphere.clone(surfaceTile.boundingSphere3D, boundingVolume);
            }

        } while (imageryIndex < imageryLen);
    };

    var southwestCornerScratch = new Cartesian3();
    var northeastCornerScratch = new Cartesian3();
    var negativeUnitY = Cartesian3.negate(Cartesian3.UNIT_Y);
    var negativeUnitZ = Cartesian3.negate(Cartesian3.UNIT_Z);
    var vectorScratch = new Cartesian3();

    /**
     * Gets the distance from the camera to the closest point on the tile.  This is used for level-of-detail selection.
     *
     * @memberof GlobeSurfaceTileProvider
     *
     * @param {QuadtreeTile} tile The tile instance.
     * @param {FrameState} frameState The state information of the current rendering frame.
     * @param {Cartesian3} cameraCartesianPosition The position of the camera in world coordinates.
     * @param {Cartographic} cameraCartographicPosition The position of the camera in cartographic / geodetic coordinates.
     *
     * @returns {Number} The distance from the camera to the closest point on the tile, in meters.
     */
    GlobeSurfaceTileProvider.prototype.getDistanceToTile = function(tile, frameState, cameraCartesianPosition, cameraCartographicPosition) {
        var surfaceTile = tile.data;

        var southwestCornerCartesian = surfaceTile.southwestCornerCartesian;
        var northeastCornerCartesian = surfaceTile.northeastCornerCartesian;
        var westNormal = surfaceTile.westNormal;
        var southNormal = surfaceTile.southNormal;
        var eastNormal = surfaceTile.eastNormal;
        var northNormal = surfaceTile.northNormal;
        var maximumHeight = surfaceTile.maximumHeight;

        if (frameState.mode !== SceneMode.SCENE3D) {
            southwestCornerCartesian = frameState.scene2D.projection.project(Rectangle.getSouthwest(tile.rectangle), southwestCornerScratch);
            southwestCornerCartesian.z = southwestCornerCartesian.y;
            southwestCornerCartesian.y = southwestCornerCartesian.x;
            southwestCornerCartesian.x = 0.0;
            northeastCornerCartesian = frameState.scene2D.projection.project(Rectangle.getNortheast(tile.rectangle), northeastCornerScratch);
            northeastCornerCartesian.z = northeastCornerCartesian.y;
            northeastCornerCartesian.y = northeastCornerCartesian.x;
            northeastCornerCartesian.x = 0.0;
            westNormal = negativeUnitY;
            eastNormal = Cartesian3.UNIT_Y;
            southNormal = negativeUnitZ;
            northNormal = Cartesian3.UNIT_Z;
            maximumHeight = 0.0;
        }

        var vectorFromSouthwestCorner = Cartesian3.subtract(cameraCartesianPosition, southwestCornerCartesian, vectorScratch);
        var distanceToWestPlane = Cartesian3.dot(vectorFromSouthwestCorner, westNormal);
        var distanceToSouthPlane = Cartesian3.dot(vectorFromSouthwestCorner, southNormal);

        var vectorFromNortheastCorner = Cartesian3.subtract(cameraCartesianPosition, northeastCornerCartesian, vectorScratch);
        var distanceToEastPlane = Cartesian3.dot(vectorFromNortheastCorner, eastNormal);
        var distanceToNorthPlane = Cartesian3.dot(vectorFromNortheastCorner, northNormal);

        var cameraHeight;
        if (frameState.mode === SceneMode.SCENE3D) {
            cameraHeight = cameraCartographicPosition.height;
        } else {
            cameraHeight = cameraCartesianPosition.x;
        }
        var distanceFromTop = cameraHeight - maximumHeight;

        var result = 0.0;

        if (distanceToWestPlane > 0.0) {
            result += distanceToWestPlane * distanceToWestPlane;
        } else if (distanceToEastPlane > 0.0) {
            result += distanceToEastPlane * distanceToEastPlane;
        }

        if (distanceToSouthPlane > 0.0) {
            result += distanceToSouthPlane * distanceToSouthPlane;
        } else if (distanceToNorthPlane > 0.0) {
            result += distanceToNorthPlane * distanceToNorthPlane;
        }

        if (distanceFromTop > 0.0) {
            result += distanceFromTop * distanceFromTop;
        }

        return Math.sqrt(result);
    };

    GlobeSurfaceTileProvider.prototype._onLayerAdded = function(layer, index) {
        if (layer.show) {
            var terrainProvider = this._terrainProvider;

            // create TileImagerys for this layer for all previously loaded tiles
            this._quadtree.forEachLoadedTile(function(tile) {
                if (layer._createTileImagerySkeletons(tile, terrainProvider)) {
                    tile.state = QuadtreeTileState.LOADING;
                }
            });

            this._layerOrderChanged = true;
        }
    };

    GlobeSurfaceTileProvider.prototype._onLayerRemoved = function(layer, index) {
        // destroy TileImagerys for this layer for all previously loaded tiles
        this._quadtree.forEachLoadedTile(function(tile) {
            var tileImageryCollection = tile.data.imagery;

            var startIndex = -1;
            var numDestroyed = 0;
            for ( var i = 0, len = tileImageryCollection.length; i < len; ++i) {
                var tileImagery = tileImageryCollection[i];
                var imagery = tileImagery.loadingImagery;
                if (!defined(imagery)) {
                    imagery = tileImagery.readyImagery;
                }
                if (imagery.imageryLayer === layer) {
                    if (startIndex === -1) {
                        startIndex = i;
                    }

                    tileImagery.freeResources();
                    ++numDestroyed;
                } else if (startIndex !== -1) {
                    // iterated past the section of TileImagerys belonging to this layer, no need to continue.
                    break;
                }
            }

            if (startIndex !== -1) {
                tileImageryCollection.splice(startIndex, numDestroyed);
            }
            // If the base layer has been removed, mark the tile as non-renderable.
            if (layer.isBaseLayer()) {
                tile.isRenderable = false;
            }
        });
    };

    GlobeSurfaceTileProvider.prototype._onLayerMoved = function(layer, newIndex, oldIndex) {
        this._layerOrderChanged = true;
    };

    GlobeSurfaceTileProvider.prototype._onLayerShownOrHidden = function(layer, index, show) {
        if (show) {
            this._onLayerAdded(layer, index);
        } else {
            this._onLayerRemoved(layer, index);
        }
    };

    function createTileUniformMap() {
        var uniformMap = {
            u_zoomedOutOceanSpecularIntensity : function() {
                return this.zoomedOutOceanSpecularIntensity;
            },
            u_oceanNormalMap : function() {
                return this.oceanNormalMap;
            },
            u_lightingFadeDistance : function() {
                return this.lightingFadeDistance;
            },
            u_center3D : function() {
                return this.center3D;
            },
            u_tileRectangle : function() {
                return this.tileRectangle;
            },
            u_modifiedModelView : function() {
                return this.modifiedModelView;
            },
            u_dayTextures : function() {
                return this.dayTextures;
            },
            u_dayTextureTranslationAndScale : function() {
                return this.dayTextureTranslationAndScale;
            },
            u_dayTextureTexCoordsRectangle : function() {
                return this.dayTextureTexCoordsRectangle;
            },
            u_dayTextureAlpha : function() {
                return this.dayTextureAlpha;
            },
            u_dayTextureBrightness : function() {
                return this.dayTextureBrightness;
            },
            u_dayTextureContrast : function() {
                return this.dayTextureContrast;
            },
            u_dayTextureHue : function() {
                return this.dayTextureHue;
            },
            u_dayTextureSaturation : function() {
                return this.dayTextureSaturation;
            },
            u_dayTextureOneOverGamma : function() {
                return this.dayTextureOneOverGamma;
            },
            u_dayIntensity : function() {
                return this.dayIntensity;
            },
            u_southAndNorthLatitude : function() {
                return this.southAndNorthLatitude;
            },
            u_southMercatorYLowAndHighAndOneOverHeight : function() {
               return this.southMercatorYLowAndHighAndOneOverHeight;
            },
            u_waterMask : function() {
                return this.waterMask;
            },
            u_waterMaskTranslationAndScale : function() {
                return this.waterMaskTranslationAndScale;
            },

            zoomedOutOceanSpecularIntensity : 0.5,
            oceanNormalMap : undefined,
            lightingFadeDistance : new Cartesian2(6500000.0, 9000000.0),

            center3D : undefined,
            modifiedModelView : new Matrix4(),
            tileRectangle : new Cartesian4(),

            dayTextures : [],
            dayTextureTranslationAndScale : [],
            dayTextureTexCoordsRectangle : [],
            dayTextureAlpha : [],
            dayTextureBrightness : [],
            dayTextureContrast : [],
            dayTextureHue : [],
            dayTextureSaturation : [],
            dayTextureOneOverGamma : [],
            dayIntensity : 0.0,

            southAndNorthLatitude : new Cartesian2(),
            southMercatorYLowAndHighAndOneOverHeight : new Cartesian3(),

            waterMask : undefined,
            waterMaskTranslationAndScale : new Cartesian4()
        };

        return uniformMap;
    }

    function createWireframeVertexArrayIfNecessary(context, provider, tile) {
        var surfaceTile = tile.data;

        if (defined(surfaceTile.wireframeVertexArray)) {
            return;
        }

        if (defined(surfaceTile.meshForWireframePromise)) {
            return;
        }

        surfaceTile.meshForWireframePromise = surfaceTile.terrainData.createMesh(provider._terrainProvider.tilingScheme, tile.x, tile.y, tile.level);
        if (!defined(surfaceTile.meshForWireframePromise)) {
            // deferrred
            return;
        }

        var vertexArray = surfaceTile.vertexArray;

        when(surfaceTile.meshForWireframePromise, function(mesh) {
            if (surfaceTile.vertexArray === vertexArray) {
                surfaceTile.wireframeVertexArray = createWireframeVertexArray(context, surfaceTile.vertexArray, mesh);
            }
            surfaceTile.meshForWireframePromise = undefined;
        });
    }

    /**
     * Creates a vertex array for wireframe rendering of a terrain tile.
     *
     * @private
     *
     * @param {Context} context The context in which to create the vertex array.
     * @param {VertexArray} vertexArray The existing, non-wireframe vertex array.  The new vertex array
     *                      will share vertex buffers with this existing one.
     * @param {TerrainMesh} terrainMesh The terrain mesh containing non-wireframe indices.
     * @returns {VertexArray} The vertex array for wireframe rendering.
     */
    function createWireframeVertexArray(context, vertexArray, terrainMesh) {
        var geometry = {
            indices : terrainMesh.indices,
            primitiveType : PrimitiveType.TRIANGLES
        };

        GeometryPipeline.toWireframe(geometry);

        var wireframeIndices = geometry.indices;
        var wireframeIndexBuffer = context.createIndexBuffer(wireframeIndices, BufferUsage.STATIC_DRAW, IndexDatatype.UNSIGNED_SHORT);
        return context.createVertexArray(vertexArray._attributes, wireframeIndexBuffer);
    }

    return GlobeSurfaceTileProvider;
});
