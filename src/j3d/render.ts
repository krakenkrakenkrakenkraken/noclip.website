
import { mat4, mat2d } from 'gl-matrix';

import { BMD, BMT, HierarchyNode, HierarchyType, MaterialEntry, Shape, ShapeDisplayFlags, TEX1_Sampler, TEX1_TextureData, DRW1MatrixKind, TTK1Animator, ANK1Animator, bindANK1Animator, BTI, bindVAF1Animator, VAF1, VAF1Animator } from './j3d';
import { TTK1, bindTTK1Animator, TRK1, bindTRK1Animator, TRK1Animator, ANK1 } from './j3d';

import * as GX_Material from '../gx/gx_material';
import { MaterialParams, PacketParams, GXTextureHolder, ColorKind, translateTexFilterGfx, translateWrapModeGfx, loadedDataCoalescerGfx, GXShapeHelperGfx, GXRenderHelperGfx, ub_MaterialParams } from '../gx/gx_render';

import { computeViewMatrix, computeModelMatrixBillboard, computeModelMatrixYBillboard, computeViewMatrixSkybox, texEnvMtx, Camera, texProjPerspMtx, computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera';
import { TextureMapping } from '../TextureHolder';
import AnimationController from '../AnimationController';
import { nArray, assertExists, assert } from '../util';
import { AABB } from '../Geometry';
import { GfxDevice, GfxSampler } from '../gfx/platform/GfxPlatform';
import { GfxBufferCoalescer, GfxCoalescedBuffers } from '../gfx/helpers/BufferHelpers';
import { ViewerRenderInput } from '../viewer';
import { GfxRenderInst, GfxRenderInstBuilder, setSortKeyDepth, GfxRendererLayer, makeSortKey, setSortKeyBias } from '../gfx/render/GfxRenderer';
import { colorCopy } from '../Color';

export class J3DTextureHolder extends GXTextureHolder<TEX1_TextureData> {
    public addJ3DTextures(device: GfxDevice, bmd: BMD, bmt: BMT | null = null) {
        this.addTextures(device, bmd.tex1.textureDatas);
        if (bmt)
            this.addTextures(device, bmt.tex1.textureDatas);
    }

    public addBTITexture(device: GfxDevice, bti: BTI): void {
        this.addTextures(device, [bti.texture]);
    }
}

class ShapeInstanceState {
    public modelMatrix: mat4 = mat4.create();
    public matrixArray: mat4[] = [];
    public matrixVisibility: boolean[] = [];
    public shapeVisibility: boolean[] = [];
    public isSkybox: boolean = false;
}

class ShapeData {
    public shapeHelpers: GXShapeHelperGfx[] = [];

    constructor(device: GfxDevice, renderHelper: GXRenderHelperGfx, public shape: Shape, coalescedBuffers: GfxCoalescedBuffers[]) {
        for (let i = 0; i < this.shape.packets.length; i++) {
            const packet = this.shape.packets[i];
            // TODO(jstpierre): Use only one ShapeHelper.
            const shapeHelper = new GXShapeHelperGfx(device, renderHelper, coalescedBuffers.shift(), this.shape.loadedVertexLayout, packet.loadedVertexData);
            this.shapeHelpers.push(shapeHelper);
        }
    }

    public destroy(device: GfxDevice) {
        this.shapeHelpers.forEach((shapeHelper) => shapeHelper.destroy(device));
    }
}

const scratchModelMatrix = mat4.create();
const scratchViewMatrix = mat4.create();
const packetParams = new PacketParams();
export class ShapeInstance {
    private renderInsts: GfxRenderInst[] = [];
    public sortKeyBias: number = 0;

    constructor(public shapeData: ShapeData) {
    }

    public pushRenderInsts(renderInstBuilder: GfxRenderInstBuilder): void {
        for (let i = 0; i < this.shapeData.shapeHelpers.length; i++) {
            const renderInst = this.shapeData.shapeHelpers[i].buildRenderInst(renderInstBuilder);
            renderInstBuilder.pushRenderInst(renderInst);
            this.renderInsts.push(renderInst);
        }
    }

    public prepareToRender(renderHelper: GXRenderHelperGfx, depth: number, viewerInput: ViewerRenderInput, shapeInstanceState: ShapeInstanceState): void {
        const shape = this.shapeData.shape;

        const modelView = this.computeModelView(viewerInput.camera, shapeInstanceState);
        packetParams.clear();

        const visible = depth >= 0;
        for (let p = 0; p < shape.packets.length; p++) {
            const packet = shape.packets[p];
            const renderInst = this.renderInsts[p];

            let instVisible = false;
            if (visible) {
                for (let i = 0; i < packet.matrixTable.length; i++) {
                    const matrixIndex = packet.matrixTable[i];

                    // Leave existing matrix.
                    if (matrixIndex === 0xFFFF)
                        continue;

                    mat4.mul(packetParams.u_PosMtx[i], modelView, shapeInstanceState.matrixArray[matrixIndex]);

                    if (shapeInstanceState.matrixVisibility[matrixIndex])
                        instVisible = true;
                }
            }

            renderInst.visible = instVisible;
            if (instVisible) {
                renderInst.sortKey = setSortKeyDepth(renderInst.parentRenderInst.sortKey, depth);
                renderInst.sortKey = setSortKeyBias(renderInst.sortKey, this.sortKeyBias);
                this.shapeData.shapeHelpers[p].fillPacketParams(packetParams, renderInst, renderHelper);
            }
        }
    }

    private computeModelView(camera: Camera, shapeInstanceState: ShapeInstanceState): mat4 {
        const shape = this.shapeData.shape;
        switch (shape.displayFlags) {
        case ShapeDisplayFlags.USE_PNMTXIDX:
        case ShapeDisplayFlags.NORMAL:
            // NORMAL is equivalent to using PNMTX0 on original hardware.
            // If we don't have a PNMTXIDX buffer, we create a phony one with all zeroes. So we're good.
            mat4.copy(scratchModelMatrix, shapeInstanceState.modelMatrix);
            break;

        case ShapeDisplayFlags.BILLBOARD:
            computeModelMatrixBillboard(scratchModelMatrix, camera);
            mat4.mul(scratchModelMatrix, shapeInstanceState.modelMatrix, scratchModelMatrix);
            break;
        case ShapeDisplayFlags.Y_BILLBOARD:
            computeModelMatrixYBillboard(scratchModelMatrix, camera);
            mat4.mul(scratchModelMatrix, shapeInstanceState.modelMatrix, scratchModelMatrix);
            break;
        default:
            throw new Error("whoops");
        }

        if (shapeInstanceState.isSkybox) {
            computeViewMatrixSkybox(scratchViewMatrix, camera);
        } else {
            computeViewMatrix(scratchViewMatrix, camera);
        }

        mat4.mul(scratchViewMatrix, scratchViewMatrix, scratchModelMatrix);
        return scratchViewMatrix;
    }
}

export class MaterialInstanceState {
    public lights = nArray(8, () => new GX_Material.Light());
}

const matrixScratch = mat4.create(), matrixScratch2 = mat4.create();
const materialParams = new MaterialParams();
export class MaterialInstance {
    public ttk1Animators: TTK1Animator[] = [];
    public trk1Animators: TRK1Animator[] = [];
    public name: string;

    public templateRenderInst: GfxRenderInst;
    private materialParamsBufferOffset: number;

    constructor(device: GfxDevice, renderHelper: GXRenderHelperGfx, private modelInstance: BMDModelInstance | null, public material: MaterialEntry, private materialHacks: GX_Material.GXMaterialHacks) {
        this.name = material.name;

        this.templateRenderInst = renderHelper.renderInstBuilder.newRenderInst();
        this.templateRenderInst.name = this.name;
        this.createProgram();
        GX_Material.translateGfxMegaState(this.templateRenderInst.setMegaStateFlags(), material.gxMaterial);
        let layer = !material.gxMaterial.ropInfo.depthTest ? GfxRendererLayer.BACKGROUND : material.translucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.setSortKeyLayer(layer);
        // Allocate our material buffer slot.
        this.materialParamsBufferOffset = renderHelper.renderInstBuilder.newUniformBufferInstance(this.templateRenderInst, ub_MaterialParams);
    }

    public setColorWriteEnabled(colorWrite: boolean): void {
        this.templateRenderInst.setMegaStateFlags({ colorWrite });
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        if (this.material.translucent)
            layer |= GfxRendererLayer.TRANSLUCENT;
        this.templateRenderInst.sortKey = makeSortKey(layer);
    }

    private createProgram(): void {
        const program = new GX_Material.GX_Program(this.material.gxMaterial, this.materialHacks);
        this.templateRenderInst.setDeviceProgram(program);
    }

    public setTexturesEnabled(v: boolean): void {
        this.materialHacks.disableTextures = !v;
        this.createProgram();
    }

    public setVertexColorsEnabled(v: boolean): void {
        this.materialHacks.disableVertexColors = !v;
        this.createProgram();
    }

    public bindTTK1(animationController: AnimationController, ttk1: TTK1): void {
        for (let i = 0; i < 8; i++) {
            const ttk1Animator = bindTTK1Animator(animationController, ttk1, this.name, i);
            if (ttk1Animator)
                this.ttk1Animators[i] = ttk1Animator;
        }
    }

    public bindTRK1(animationController: AnimationController, trk1: TRK1): void {
        for (let i: ColorKind = 0; i < ColorKind.COUNT; i++) {
            const trk1Animator = bindTRK1Animator(animationController, trk1, this.name, i);
            if (trk1Animator)
                this.trk1Animators[i] = trk1Animator;
        }
    }

    private clampTo8Bit(color: GX_Material.Color): void {
        // TODO(jstpierre): Actually clamp. For now, just make sure it doesn't go negative.
        color.r = Math.max(color.r, 0);
        color.g = Math.max(color.g, 0);
        color.b = Math.max(color.b, 0);
        color.a = Math.max(color.a, 0);
    }

    private calcColor(dst: GX_Material.Color, i: ColorKind, fallbackColor: GX_Material.Color, clampTo8Bit: boolean) {
        if (this.trk1Animators[i] !== undefined) {
            this.trk1Animators[i].calcColor(dst);
            if (clampTo8Bit)
                this.clampTo8Bit(dst);
            return;
        }

        let color: GX_Material.Color;
        if (this.modelInstance !== null && this.modelInstance.colorOverrides[i] !== undefined) {
            color = this.modelInstance.colorOverrides[i];
        } else {
            color = fallbackColor;
        }

        let alpha: number;
        if (this.modelInstance !== null && this.modelInstance.alphaOverrides[i]) {
            alpha = color.a;
        } else {
            alpha = fallbackColor.a;
        }

        colorCopy(dst, color, alpha);
        if (clampTo8Bit)
            this.clampTo8Bit(dst);
    }

    public fillMaterialParams(materialParams: MaterialParams, camera: Camera, materialInstanceState: MaterialInstanceState, bmdModel: BMDModel, textureHolder: GXTextureHolder): void {
        const material = this.material;

        this.calcColor(materialParams.u_Color[ColorKind.MAT0],  ColorKind.MAT0,  material.colorMatRegs[0],   false);
        this.calcColor(materialParams.u_Color[ColorKind.MAT1],  ColorKind.MAT1,  material.colorMatRegs[1],   false);
        this.calcColor(materialParams.u_Color[ColorKind.AMB0],  ColorKind.AMB0,  material.colorAmbRegs[0],   false);
        this.calcColor(materialParams.u_Color[ColorKind.AMB1],  ColorKind.AMB1,  material.colorAmbRegs[1],   false);
        this.calcColor(materialParams.u_Color[ColorKind.K0],    ColorKind.K0,    material.colorConstants[0], true);
        this.calcColor(materialParams.u_Color[ColorKind.K1],    ColorKind.K1,    material.colorConstants[1], true);
        this.calcColor(materialParams.u_Color[ColorKind.K2],    ColorKind.K2,    material.colorConstants[2], true);
        this.calcColor(materialParams.u_Color[ColorKind.K3],    ColorKind.K3,    material.colorConstants[3], true);
        this.calcColor(materialParams.u_Color[ColorKind.CPREV], ColorKind.CPREV, material.colorRegisters[3], false);
        this.calcColor(materialParams.u_Color[ColorKind.C0],    ColorKind.C0,    material.colorRegisters[0], false);
        this.calcColor(materialParams.u_Color[ColorKind.C1],    ColorKind.C1,    material.colorRegisters[1], false);
        this.calcColor(materialParams.u_Color[ColorKind.C2],    ColorKind.C2,    material.colorRegisters[2], false);

        // Bind textures.
        for (let i = 0; i < material.textureIndexes.length; i++) {
            const texIndex = material.textureIndexes[i];
            const m = materialParams.m_TextureMapping[i];
            m.reset();

            if (texIndex >= 0)
                bmdModel.fillTextureMapping(materialParams.m_TextureMapping[i], textureHolder, texIndex);
        }

        this.templateRenderInst.setSamplerBindingsFromTextureMappings(materialParams.m_TextureMapping);

        // Bind our texture matrices.
        const scratch = matrixScratch;
        for (let i = 0; i < material.texMatrices.length; i++) {
            const texMtx = material.texMatrices[i];
            const dst = materialParams.u_TexMtx[i];
            mat4.identity(dst);

            if (texMtx === null)
                continue;

            const flipY = materialParams.m_TextureMapping[i].flipY;
            const flipYScale = flipY ? -1.0 : 1.0;

            // First, compute input matrix.
            switch (texMtx.type) {
            case 0x00:
            case 0x01: // Delfino Plaza
            case 0x02: // pinnaParco7.szs
            case 0x08: // Peach Beach.
            case 0x0A: // Wind Waker pedestal?
            case 0x0B: // Luigi Circuit
                // No mapping.
                mat4.identity(dst);
                break;
            case 0x06: // Rainbow Road
            case 0x07: // Rainbow Road
                // Environment mapping. Uses the normal matrix.
                // Normal matrix. Emulated here by the view matrix with the translation lopped off...
                mat4.copy(dst, camera.viewMatrix);
                dst[12] = 0;
                dst[13] = 0;
                dst[14] = 0;
                break;
            case 0x09:
                // Projection. Used for indtexwater, mostly.
                mat4.copy(dst, camera.viewMatrix);
                break;
            default:
                throw "whoops";
            }

            // Now apply effects.
            switch(texMtx.type) {
            case 0x00:
            case 0x01:
            case 0x02:
            case 0x0A:
            case 0x0B:
                // In the case of flipY, invert the Y coordinates. This is not a J3D thing, this is
                // compensating for OpenGL being bad in other cases.
                if (flipY) {
                    texEnvMtx(scratch, 1, 1, 0, 1);
                    mat4.mul(dst, scratch, dst);
                }
                break;
            case 0x06: // Rainbow Road
                // Environment mapping
                texEnvMtx(scratch, -0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                mat4.mul(dst, texMtx.effectMatrix, dst);
                break;
            case 0x07: // Rainbow Road
            case 0x08: // Peach Beach
                mat4.mul(dst, texMtx.effectMatrix, dst);
                texProjPerspMtx(scratch, camera.fovY, camera.aspect, 0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                break;
            case 0x09: // Peach's Castle Garden.
                // Don't apply effectMatrix to perspective. It appears to be
                // a projection matrix preconfigured for GC.
                // mat4.mul(dst, texMtx.effectMatrix, dst);
                texProjPerspMtx(scratch, camera.fovY, camera.aspect, 0.5, -0.5 * flipYScale, 0.5, 0.5);
                mat4.mul(dst, scratch, dst);
                break;
            default:
                throw "whoops";
            }

            // Apply SRT.
            if (this.ttk1Animators[i] !== undefined) {
                this.ttk1Animators[i].calcTexMtx(scratch);
            } else {
                mat4.copy(scratch, material.texMatrices[i].matrix);
            }

            // SRT matrices have translation in fourth component, but we want our matrix to have translation
            // in third component. Swap.
            const tx = scratch[12];
            scratch[12] = scratch[8];
            scratch[8] = tx;
            const ty = scratch[13];
            scratch[13] = scratch[9];
            scratch[9] = ty;

            mat4.mul(dst, scratch, dst);
        }

        for (let i = 0; i < material.postTexMatrices.length; i++) {
            const postTexMtx = material.postTexMatrices[i];
            if (postTexMtx === null)
                continue;

            const finalMatrix = postTexMtx.matrix;
            mat4.copy(materialParams.u_PostTexMtx[i], finalMatrix);
        }

        for (let i = 0; i < material.indTexMatrices.length; i++) {
            const indTexMtx = material.indTexMatrices[i];
            if (indTexMtx === null)
                continue;

            const a = indTexMtx[0], c = indTexMtx[1], tx = indTexMtx[2];
            const b = indTexMtx[3], d = indTexMtx[4], ty = indTexMtx[5];
            mat2d.set(materialParams.u_IndTexMtx[i], a, b, c, d, tx, ty);
        }

        for (let i = 0; i < materialInstanceState.lights.length; i++)
            materialParams.u_Lights[i].copy(materialInstanceState.lights[i]);
    }

    public prepareToRender(renderHelper: GXRenderHelperGfx, viewerInput: ViewerRenderInput, materialInstanceState: MaterialInstanceState, bmdModel: BMDModel, textureHolder: GXTextureHolder): void {
        this.fillMaterialParams(materialParams, viewerInput.camera, materialInstanceState, bmdModel, textureHolder);
        renderHelper.fillMaterialParams(materialParams, this.materialParamsBufferOffset);
    }
}

export class BMDModel {
    private realized: boolean = false;

    private gfxSamplers!: GfxSampler[];
    public tex1Samplers!: TEX1_Sampler[];

    private bufferCoalescer: GfxBufferCoalescer;

    public shapeData: ShapeData[] = [];
    public hasBillboard: boolean;

    public bbox = new AABB();

    constructor(
        device: GfxDevice,
        renderHelper: GXRenderHelperGfx,
        public bmd: BMD,
        public bmt: BMT | null = null,
    ) {
        const tex1 = (bmt !== null && bmt.tex1 !== null) ? bmt.tex1 : bmd.tex1;

        this.tex1Samplers = tex1.samplers;
        this.gfxSamplers = this.tex1Samplers.map((sampler) => BMDModel.translateSampler(device, sampler));

        // Load shape data.
        const loadedVertexDatas = [];
        for (let i = 0; i < bmd.shp1.shapes.length; i++)
            for (let j = 0; j < bmd.shp1.shapes[i].packets.length; j++)
                loadedVertexDatas.push(bmd.shp1.shapes[i].packets[j].loadedVertexData);
        this.bufferCoalescer = loadedDataCoalescerGfx(device, loadedVertexDatas);

        for (let i = 0; i < bmd.shp1.shapes.length; i++) {
            const shp1 = bmd.shp1.shapes[i];

            // Compute overall bbox.
            this.bbox.union(this.bbox, shp1.bbox);

            // Look for billboards.
            if (shp1.displayFlags === ShapeDisplayFlags.BILLBOARD || shp1.displayFlags === ShapeDisplayFlags.Y_BILLBOARD)
                this.hasBillboard = true;

            this.shapeData.push(new ShapeData(device, renderHelper, shp1, this.bufferCoalescer.coalescedBuffers));
        }

        // Load scene graph.
        this.realized = true;
    }

    public destroy(device: GfxDevice): void {
        if (!this.realized)
            return;

        this.bufferCoalescer.destroy(device);
        this.shapeData.forEach((command) => command.destroy(device));

        this.gfxSamplers.forEach((sampler) => device.destroySampler(sampler));
        this.realized = false;
    }

    public fillTextureMapping(m: TextureMapping, textureHolder: GXTextureHolder, texIndex: number): void {
        const tex1Sampler = this.tex1Samplers[texIndex];
        textureHolder.fillTextureMapping(m, tex1Sampler.name);
        m.gfxSampler = this.gfxSamplers[tex1Sampler.index];
        m.lodBias = tex1Sampler.lodBias;
    }

    private static translateSampler(device: GfxDevice, sampler: TEX1_Sampler): GfxSampler {
        const [minFilter, mipFilter] = translateTexFilterGfx(sampler.minFilter);
        const [magFilter]            = translateTexFilterGfx(sampler.magFilter);

        const gfxSampler = device.createSampler({
            wrapS: translateWrapModeGfx(sampler.wrapS),
            wrapT: translateWrapModeGfx(sampler.wrapT),
            minFilter, mipFilter, magFilter,
            minLOD: sampler.minLOD,
            maxLOD: sampler.maxLOD,
        });

        return gfxSampler;
    }
}

const bboxScratch = new AABB();
export class BMDModelInstance {
    public name: string = '';
    public visible: boolean = true;
    public isSkybox: boolean = false;
    public passMask: number = 0x01;

    public modelMatrix = mat4.create();

    public colorOverrides: GX_Material.Color[] = [];
    public alphaOverrides: boolean[] = [];

    // Animations.
    public animationController = new AnimationController();
    public ank1Animator: ANK1Animator | null = null;
    public vaf1Animator: VAF1Animator | null = null;

    // Temporary state when calculating bone matrices.
    private jointMatrices: mat4[];
    private jointVisibility: boolean[];

    private templateRenderInst: GfxRenderInst;
    private materialInstanceState = new MaterialInstanceState();
    private materialInstances: MaterialInstance[] = [];
    private shapeInstances: ShapeInstance[] = [];
    private shapeInstanceState = new ShapeInstanceState();
    private materialHacks: GX_Material.GXMaterialHacks = {};

    constructor(
        device: GfxDevice,
        renderHelper: GXRenderHelperGfx,
        private textureHolder: J3DTextureHolder,
        public bmdModel: BMDModel,
        materialHacks?: GX_Material.GXMaterialHacks
    ) {
        if (materialHacks)
            Object.assign(this.materialHacks, materialHacks);

        this.shapeInstances = this.bmdModel.shapeData.map((shapeData) => {
            return new ShapeInstance(shapeData);
        });

        this.templateRenderInst = renderHelper.renderInstBuilder.pushTemplateRenderInst();
        const mat3 = (this.bmdModel.bmt !== null && this.bmdModel.bmt.mat3 !== null) ? this.bmdModel.bmt.mat3 : this.bmdModel.bmd.mat3;
        this.materialInstances = mat3.materialEntries.map((materialEntry) => {
            return new MaterialInstance(device, renderHelper, this, materialEntry, this.materialHacks);
        });
        renderHelper.renderInstBuilder.popTemplateRenderInst();

        const bmd = this.bmdModel.bmd;

        this.translateSceneGraph(bmd.inf1.sceneGraph, renderHelper);

        const numJoints = bmd.jnt1.joints.length;
        this.jointMatrices = nArray(numJoints, () => mat4.create());
        this.jointVisibility = nArray(numJoints, () => true);

        const numMatrices = bmd.drw1.matrixDefinitions.length;
        this.shapeInstanceState.matrixArray = nArray(numMatrices, () => mat4.create());
        this.shapeInstanceState.matrixVisibility = nArray(numMatrices, () => true);
        const numShapes = bmd.shp1.shapes.length;
        this.shapeInstanceState.shapeVisibility = nArray(numShapes, () => true);
    }

    private translateSceneGraph(root: HierarchyNode, renderHelper: GXRenderHelperGfx): void {
        let currentMaterial: MaterialInstance | null = null;
        const renderInstBuilder = renderHelper.renderInstBuilder;
        let translucentDrawIndex = 0;

        const translateNode = (node: HierarchyNode) => {
            switch (node.type) {
            case HierarchyType.Material:
                currentMaterial = this.materialInstances[node.materialIdx];
                break;
            case HierarchyType.Shape:
                assertExists(currentMaterial);
                renderInstBuilder.pushTemplateRenderInst(currentMaterial.templateRenderInst);
                const shapeInstance = this.shapeInstances[node.shapeIdx];
                // Translucent draws need to be in-order, for J3D, as far as I can tell?
                if (currentMaterial.material.translucent)
                    shapeInstance.sortKeyBias = ++translucentDrawIndex;
                shapeInstance.pushRenderInsts(renderInstBuilder);
                renderInstBuilder.popTemplateRenderInst();
                break;
            }

            for (let i = 0; i < node.children.length; i++)
                translateNode(node.children[i]);
        };

        translateNode(root);
    }

    public destroy(device: GfxDevice): void {
        this.bmdModel.destroy(device);
    }

    public setVisible(v: boolean): void {
        this.visible = v;
    }

    /**
     * Render Hack. Sets whether vertex colors are enabled. If vertex colors are disabled,
     * then opaque white is substituted for them in the shader generated for every material.
     *
     * By default, vertex colors are enabled.
     */
    public setVertexColorsEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setVertexColorsEnabled(v);
    }

    /**
     * Render Hack. Sets whether texture samples are enabled. If texture samples are disabled,
     * then opaque white is substituted for them in the shader generated for every material.
     *
     * By default, textures are enabled.
     */
    public setTexturesEnabled(v: boolean): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setTexturesEnabled(v);
    }

    public setSortKeyLayer(layer: GfxRendererLayer): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].setSortKeyLayer(layer);
    }

    /**
     * Sets whether color write is enabled. This is equivalent to the native GX function
     * GXSetColorUpdate. There is no MAT3 material flag for this, so some games have special
     * engine hooks to enable and disable color write at runtime.
     * 
     * Specifically, Wind Waker turns off color write when drawing a specific part of character's
     * eyes so it can draw them on top of the hair.
     */
    public setMaterialColorWriteEnabled(materialName: string, colorWrite: boolean): void {
        this.materialInstances.find((m) => m.name === materialName).setColorWriteEnabled(colorWrite);
    }

    /**
     * Sets a color override for a specific color. The MAT3 has defaults for every color,
     * but engines can override colors on a model with their own colors if wanted. Color
     * overrides also take precedence over any bound color animations.
     * 
     * Choose which color "slot" to override with {@param colorKind}.
     * 
     * It is currently not possible to specify a color override per-material.
     *
     * By default, the alpha value in {@param color} is not used. Set {@param useAlpha}
     * to true to obey the alpha color override.
     *
     * To unset a color override, pass {@constant undefined} as for {@param color}.
     */
    public setColorOverride(colorKind: ColorKind, color: GX_Material.Color | undefined, useAlpha: boolean = false): void {
        this.colorOverrides[colorKind] = color;
        this.alphaOverrides[colorKind] = useAlpha;
    }

    public setGXLight(i: number, light: GX_Material.Light): void {
        this.materialInstanceState.lights[i].copy(light);
    }

    /**
     * Binds {@param ttk1} (texture animations) to this model instance.
     * TTK1 objects can be parsed from {@link BTK} files. See {@link BTK.parse}.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * By default, this will default to this instance's own {@member animationController}.
     */
    public bindTTK1(ttk1: TTK1, animationController: AnimationController = this.animationController): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].bindTTK1(animationController, ttk1);
    }

    /**
     * Binds {@param trk1} (color register animations) to this model instance.
     * TRK1 objects can be parsed from {@link BRK} files. See {@link BRK.parse}.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * By default, this will default to this instance's own {@member animationController}.
     */
    public bindTRK1(trk1: TRK1, animationController: AnimationController = this.animationController): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].bindTRK1(animationController, trk1);
    }

    /**
     * Binds {@param ank1} (joint animations) to this model instance.
     * ANK1 objects can be parsed from {@link BCK} files. See {@link BCK.parse}.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * By default, this will default to this instance's own {@member animationController}.
     */
    public bindANK1(ank1: ANK1, animationController: AnimationController = this.animationController): void {
        this.ank1Animator = bindANK1Animator(animationController, ank1);
    }

    /**
     * Binds {@param vaf1} (shape visibility animations) to this model instance.
     * VAF1 objects can be parsed from {@link BVA} files. See {@link BVA.parse}.
     *
     * @param animationController An {@link AnimationController} to control the progress of this animation to.
     * By default, this will default to this instance's own {@member animationController}.
     */
    public bindVAF1(vaf1: VAF1, animationController: AnimationController = this.animationController): void {
        assert(vaf1.visibilityAnimationTracks.length === this.shapeInstances.length);
        this.vaf1Animator = bindVAF1Animator(animationController, vaf1);
    }

    public getJointMatrixReference(jointName: string): mat4 {
        // Find the matrix that corresponds to the bone.
        const parentJointIndex = this.bmdModel.bmd.jnt1.joints.findIndex((j) => j.name === jointName);
        assert(parentJointIndex >= 0);
        return this.jointMatrices[parentJointIndex];
    }

    private isAnyShapeVisible(): boolean {
        for (let i = 0; i < this.shapeInstanceState.matrixVisibility.length; i++)
            if (this.shapeInstanceState.matrixVisibility[i])
                return true;
        return false;
    }

    public prepareToRender(renderHelper: GXRenderHelperGfx, viewerInput: ViewerRenderInput, visible: boolean = true): void {
        let modelVisible = visible && this.visible;

        if (modelVisible) {
            this.templateRenderInst.name = this.name;
            this.templateRenderInst.passMask = this.passMask;

            this.animationController.setTimeInMilliseconds(viewerInput.time);

            // Compute our root joint.
            const rootJointMatrix = matrixScratch;
            mat4.copy(rootJointMatrix, this.modelMatrix);

            // Billboards shouldn't have their root joint modified, given that we have to compute a new model
            // matrix that faces the camera view.
            // TODO(jstpierre): There's a way to do this without this hackiness, I'm sure of it.
            if (this.bmdModel.hasBillboard) {
                mat4.copy(this.shapeInstanceState.modelMatrix, rootJointMatrix);
                mat4.identity(rootJointMatrix);
            } else {
                mat4.identity(this.shapeInstanceState.modelMatrix);
            }

            // Skyboxes implicitly center themselves around the view matrix (their view translation is removed).
            // While we could represent this, a skybox is always visible in theory so it's probably not worth it
            // to cull. If we ever have a fancy skybox model, then it might be worth it to represent it in world-space.
            //
            // Billboards have their model matrix modified to face the camera, so their world space position doesn't
            // quite match what they kind of do.
            //
            // For now, we simply don't cull both of these special cases, hoping they'll be simple enough to just always
            // render. In theory, we could cull billboards using the bounding sphere.
            const disableCulling = this.isSkybox || this.bmdModel.hasBillboard;

            this.shapeInstanceState.isSkybox = this.isSkybox;
            this.updateMatrixArray(viewerInput.camera, rootJointMatrix, disableCulling);

            // If entire model is culled away, then we don't need to render anything.
            if (!this.isAnyShapeVisible())
                modelVisible = false;
        }

        // Now update our materials and shapes.
        let depth = -1;
        if (modelVisible) {
            for (let i = 0; i < this.materialInstances.length; i++)
                this.materialInstances[i].prepareToRender(renderHelper, viewerInput, this.materialInstanceState, this.bmdModel, this.textureHolder);

            // Use the root joint to calculate depth.
            const rootJoint = this.bmdModel.bmd.jnt1.joints[0];
            bboxScratch.transform(rootJoint.bbox, this.modelMatrix);
            depth = Math.max(computeViewSpaceDepthFromWorldSpaceAABB(viewerInput.camera, bboxScratch), 0);
        }

        for (let i = 0; i < this.shapeInstances.length; i++) {
            const shapeVisibility = this.vaf1Animator !== null ? this.vaf1Animator.calcVisibility(i) : true;
            const shapeDepth = shapeVisibility ? depth : -1;
            this.shapeInstances[i].prepareToRender(renderHelper, shapeDepth, viewerInput, this.shapeInstanceState);
        }
    }

    private updateJointMatrixHierarchy(camera: Camera, node: HierarchyNode, parentJointMatrix: mat4, disableCulling: boolean): void {
        // TODO(jstpierre): Don't pointer chase when traversing hierarchy every frame...
        const jnt1 = this.bmdModel.bmd.jnt1;

        switch (node.type) {
        case HierarchyType.Joint:
            const jointIndex = node.jointIdx;

            let jointMatrix: mat4;
            if (this.ank1Animator !== null && this.ank1Animator.calcJointMatrix(matrixScratch2, jointIndex)) {
                jointMatrix = matrixScratch2;
            } else {
                jointMatrix = jnt1.joints[jointIndex].matrix;
            }

            const dstJointMatrix = this.jointMatrices[jointIndex];
            mat4.mul(dstJointMatrix, parentJointMatrix, jointMatrix);

            // TODO(jstpierre): Use shape visibility if the bbox is empty.
            if (disableCulling || jnt1.joints[jointIndex].bbox.isEmpty()) {
                this.jointVisibility[jointIndex] = true;
            } else {
                // Frustum cull.
                // Note to future self: joint bboxes do *not* contain their child joints (see: trees in Super Mario Sunshine).
                // You *cannot* use PARTIAL_INTERSECTION to optimize frustum culling.
                bboxScratch.transform(jnt1.joints[jointIndex].bbox, dstJointMatrix);
                this.jointVisibility[jointIndex] = camera.frustum.contains(bboxScratch);
            }

            for (let i = 0; i < node.children.length; i++)
                this.updateJointMatrixHierarchy(camera, node.children[i], dstJointMatrix, disableCulling);
            break;
        default:
            // Pass through.
            for (let i = 0; i < node.children.length; i++)
                this.updateJointMatrixHierarchy(camera, node.children[i], parentJointMatrix, disableCulling);
            break;
        }
    }

    private updateMatrixArray(camera: Camera, rootJointMatrix: mat4, disableCulling: boolean): void {
        const inf1 = this.bmdModel.bmd.inf1;
        const drw1 = this.bmdModel.bmd.drw1;
        const evp1 = this.bmdModel.bmd.evp1;

        this.updateJointMatrixHierarchy(camera, inf1.sceneGraph, rootJointMatrix, disableCulling);

        // Now update our matrix definition array.
        for (let i = 0; i < drw1.matrixDefinitions.length; i++) {
            const matrixDefinition = drw1.matrixDefinitions[i];
            const dst = this.shapeInstanceState.matrixArray[i];
            if (matrixDefinition.kind === DRW1MatrixKind.Joint) {
                const matrixVisible = this.jointVisibility[matrixDefinition.jointIndex];
                this.shapeInstanceState.matrixVisibility[i] = matrixVisible;
                mat4.copy(dst, this.jointMatrices[matrixDefinition.jointIndex]);
            } else if (matrixDefinition.kind === DRW1MatrixKind.Envelope) {
                dst.fill(0);
                const envelope = evp1.envelopes[matrixDefinition.envelopeIndex];

                let matrixVisible = false;
                for (let i = 0; i < envelope.weightedBones.length; i++) {
                    const weightedBone = envelope.weightedBones[i];
                    if (this.jointVisibility[weightedBone.index]) {
                        matrixVisible = true;
                        break;
                    }
                }

                this.shapeInstanceState.matrixVisibility[i] = matrixVisible;

                for (let i = 0; i < envelope.weightedBones.length; i++) {
                    const weightedBone = envelope.weightedBones[i];
                    const inverseBindPose = evp1.inverseBinds[weightedBone.index];
                    mat4.mul(matrixScratch, this.jointMatrices[weightedBone.index], inverseBindPose);
                    mat4.multiplyScalarAndAdd(dst, dst, matrixScratch, weightedBone.weight);
                }
            }
        }
    }
}
