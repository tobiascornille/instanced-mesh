import { Box3, BufferAttribute, BufferGeometry, Camera, DataTexture, FloatType, Frustum, InstancedBufferAttribute, Intersection, Material, Matrix4, Mesh, Object3DEventMap, RGFormat, Ray, Raycaster, RedFormat, Scene, ShaderMaterial, Sphere, Vector3, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";
import { createTexture_mat4 } from "../utils/createTexture";
import { GLInstancedBufferAttribute } from "./GLInstancedBufferAttribute";
import { InstancedEntity, UniformValue, UniformValueNoNumber } from "./InstancedEntity";
import { InstancedMeshBVH } from "./InstancedMeshBVH";
import { InstancedRenderItem, InstancedRenderList } from "./InstancedRenderList";

// TODO Add expand and count/maxCount when create?
// TODO static scene, avoid culling if no camera move?
// TODO getMorphAt to InstancedEntity
// TODO sorting if CullingNone
// TODO: partial texture update
// TODO: matrix update optimized if changes only rot, pos or scale.
// TODO: addSetMatrix method and use decompose
// TODO: send indexes data to gpu only if changes

export type Entity<T> = InstancedEntity & T;
export type CreateEntityCallback<T> = (obj: Entity<T>, index: number) => void;

export interface InstancedMesh2Params<T, G extends BufferGeometry, M extends Material | Material[]> {
  geometry?: G,
  material?: M,
  onInstanceCreation?: CreateEntityCallback<Entity<T>>;
  perObjectFrustumCulled?: boolean;
  sortObjects?: boolean;
  bvh?: BVHParams;
  // createEntities?: boolean; // TODO
}

export interface BVHParams {
  margin?: number;
  highPrecision?: boolean;
}

export class InstancedMesh2<
  TCustomData = {},
  TGeometry extends BufferGeometry = BufferGeometry,
  TMaterial extends Material | Material[] = Material,
  TEventMap extends Object3DEventMap = Object3DEventMap
> extends Mesh<TGeometry, TMaterial, TEventMap> {

  public override type = 'InstancedMesh2';
  public isInstancedMesh2 = true;
  public instances: Entity<TCustomData>[];
  public instanceIndex: GLInstancedBufferAttribute;
  public instanceTexture: DataTexture;
  public morphTexture: DataTexture = null;
  public boundingBox: Box3 = null;
  public boundingSphere: Sphere = null;
  public instancesCount: number; // TODO handle update from dynamic to static
  public bvh: InstancedMeshBVH;
  public perObjectFrustumCulled: boolean;
  public sortObjects: boolean;
  public customSort = null;
  public raycastOnlyFrustum = false;
  /** @internal */ public _matrixArray: Float32Array;
  protected _count: number;
  protected _maxCount: number;
  protected _material: TMaterial;
  protected _uniformsSetCallback = new Map<string, (id: number, value: UniformValue) => void>();

  // HACK TO MAKE IT WORK WITHOUT UPDATE CORE
  private isInstancedMesh = true; // must be set to use instancing rendering
  private instanceMatrix = new InstancedBufferAttribute(new Float32Array(0), 16); // must be init to avoid exception
  private instanceColor = null; // must be null to avoid exception

  public get count() { return this._count }
  public get maxCount() { return this._maxCount }

  // @ts-ignore
  public override get material() { return this._material }
  public override set material(value: TMaterial) {
    this._material = value;
    this.patchMaterials(value);
  }

  public override onBeforeRender(renderer: WebGLRenderer, scene: Scene, camera: Camera, geometry: BufferGeometry, material: Material): void {
    if (!this.perObjectFrustumCulled) return;

    this.frustumCulling(camera);

    const gl = renderer.getContext();
    const instanceIndex = this.instanceIndex;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceIndex.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceIndex.array, 0, this._count);
  }

  override onBeforeShadow(renderer: WebGLRenderer, object: any, camera: any, shadowCamera: any, geometry: any, depthMaterial: any): void { // TIX d.ts
    if (!(depthMaterial as Material).isInstancedMeshPatched) {
      this.patchMaterial(depthMaterial);
    }
    this.onBeforeRender(renderer, null, shadowCamera, geometry, depthMaterial);
  }

  /** THIS MATERIAL AND GEOMETRY CANNOT BE SHARED */
  constructor(renderer: WebGLRenderer, count: number, config: InstancedMesh2Params<TCustomData, TGeometry, TMaterial>) {
    if (renderer === undefined) throw new Error("'renderer' is mandatory.");
    if (count === undefined) throw new Error("'count' is mandatory.");
    if (config === undefined) throw new Error("'config' is mandatory.");

    super(config.geometry, config.material);

    this.perObjectFrustumCulled = config.perObjectFrustumCulled ?? true;
    this.sortObjects = config.sortObjects ?? false;
    this.frustumCulled = !this.perObjectFrustumCulled;
    this.instancesCount = count;
    this._maxCount = count;
    this._count = count;
    this._material = config.material;

    if (config.bvh) {
      this.bvh = new InstancedMeshBVH(this, config.bvh.margin, config.bvh.highPrecision);
    }

    this.initIndixes(renderer);
    this.initMatricesTexture();
    this.createInstances(config.onInstanceCreation);
  }

  protected initIndixes(renderer: WebGLRenderer): void {
    const gl = renderer.getContext();
    const buffer = gl.createBuffer();
    const array = new Uint32Array(this._maxCount);

    for (let i = 0; i < this._maxCount; i++) {
      array[i] = i;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, array, gl.DYNAMIC_DRAW);

    this.instanceIndex = new GLInstancedBufferAttribute(buffer, gl.UNSIGNED_INT, 1, 4, array.length, array); // UNSIGNED_SHORT usare anche questo se < 65k
    this.geometry.setAttribute("instanceIndex", this.instanceIndex as unknown as BufferAttribute); // TODO fix d.ts
  }

  protected initMatricesTexture(): void {
    this.instanceTexture = createTexture_mat4(this._maxCount)
    this._matrixArray = this.instanceTexture.image.data as unknown as Float32Array;
  }

  protected createInstances(onInstanceCreation: CreateEntityCallback<Entity<TCustomData>>): void {
    const count = this._maxCount; // TODO we can create only first N count
    this.instances = new Array(count);

    for (let i = 0; i < count; i++) {
      const instance = new InstancedEntity(this, i) as Entity<TCustomData>;
      this.instances[i] = instance;

      if (onInstanceCreation) {
        onInstanceCreation(instance, i);
        instance.updateMatrix();
      }
    }

    if (onInstanceCreation) {
      this.bvh?.createFromArray();
    }
  }

  protected patchMaterials(material: TMaterial): void {
    if (!material) return;

    if ((material as Material).isMaterial) {
      this.patchMaterial(material as Material);
      return;
    }

    for (const m of material as Material[]) {
      this.patchMaterial(m);
    }
  }

  protected patchMaterial(material: Material): void {
    if (material.isInstancedMeshPatched) return;

    const onBeforeCompile = material.onBeforeCompile;

    // use onBuild instead to access to object.. ONBUILD HAS BEEN REMOVED RIP
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
      if (onBeforeCompile) onBeforeCompile(shader, renderer);

      if (!shader.instancing) return;

      shader.instancing = false;
      shader.instancingColor = false; // TODO
      shader.uniforms.instanceTexture = { value: this.instanceTexture };

      if (!shader.defines) shader.defines = {};
      shader.defines["USE_INSTANCING_INDIRECT"] = "";

      shader.vertexShader = shader.vertexShader.replace("#include <batching_vertex>", "#include <batching_vertex>\n#include <instanced_vertex>");
      shader.vertexShader = shader.vertexShader.replace("#include <batching_pars_vertex>", "#include <batching_pars_vertex>\n#include <instanced_pars_vertex>");
    }

    material.isInstancedMeshPatched = true;
  }

  public setUniformAt(id: number, name: string, value: UniformValue): void { // TODO support multimaterial?
    let setCallback = this._uniformsSetCallback.get(name);

    if (!setCallback) {
      const texture = (this.material as ShaderMaterial).uniforms[name].value as DataTexture;
      const size = texture.format === RedFormat ? 1 : (texture.format === RGFormat ? 2 : 4); // 3 is not supported
      const array = texture.image.data;

      if (size === 1) {
        setCallback = (id: number, value: UniformValue) => { array[id] = value as number };
      } else {
        setCallback = (id: number, value: UniformValue) => { (value as UniformValueNoNumber).toArray(array, id * size) };
      }

      this._uniformsSetCallback.set(name, setCallback);
    }

    setCallback(id, value);
  }

  /** @internal */
  public composeMatrixInstance(entity: InstancedEntity): void {
    const position = entity.position;
    const quaternion = entity.quaternion as any;
    const scale = entity.scale;
    const te = this._matrixArray;
    const offset = entity.id * 16;

    const x = quaternion._x, y = quaternion._y, z = quaternion._z, w = quaternion._w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    const sx = scale.x, sy = scale.y, sz = scale.z;

    te[offset + 0] = (1 - (yy + zz)) * sx;
    te[offset + 1] = (xy + wz) * sx;
    te[offset + 2] = (xz - wy) * sx;
    te[offset + 3] = 0;

    te[offset + 4] = (xy - wz) * sy;
    te[offset + 5] = (1 - (xx + zz)) * sy;
    te[offset + 6] = (yz + wx) * sy;
    te[offset + 7] = 0;

    te[offset + 8] = (xz + wy) * sz;
    te[offset + 9] = (yz - wx) * sz;
    te[offset + 10] = (1 - (xx + yy)) * sz;
    te[offset + 11] = 0;

    te[offset + 12] = position.x;
    te[offset + 13] = position.y;
    te[offset + 14] = position.z;
    te[offset + 15] = 1;

    this.instanceTexture.needsUpdate = true;
    this.bvh?.move(entity);
  }

  public override raycast(raycaster: Raycaster, result: Intersection[]): void {
    if (this.material === undefined) return;

    const raycastFrustum = this.raycastOnlyFrustum && this.perObjectFrustumCulled && !this.bvh;
    let instancesToCheck: InstancedEntity[] | Uint32Array;
    _mesh.geometry = this.geometry;
    _mesh.material = this.material;

    const originalRay = raycaster.ray;
    const originalNear = raycaster.near;
    const originalFar = raycaster.far;

    _invMatrixWorld.copy(this.matrixWorld).invert();

    extractMatrixScale(this.matrixWorld, _worldScale);
    _direction.copy(raycaster.ray.direction).multiply(_worldScale);
    const scaleFactor = _direction.length();

    raycaster.ray = _ray.copy(raycaster.ray).applyMatrix4(_invMatrixWorld);
    raycaster.near /= scaleFactor;
    raycaster.far /= scaleFactor;

    if (this.bvh) {

      instancesToCheck = _instancesIntersected;
      this.bvh.raycast(raycaster, _instancesIntersected);

    } else {

      if (this.boundingSphere === null) this.computeBoundingSphere();
      _sphere.copy(this.boundingSphere);
      if (!raycaster.ray.intersectsSphere(_sphere)) return;

      instancesToCheck = raycastFrustum ? this.instanceIndex.array as Uint32Array : this.instances;

    }

    const instances = this.instances;
    const instancesCount = this.instancesCount;
    const checkCount = raycastFrustum ? this._count : Math.min(instancesToCheck.length, instancesCount);
    const getObjectCallback = raycastFrustum ? getObjectByIndex : getObject;

    for (let i = 0; i < checkCount; i++) {
      const object = getObjectCallback(i);
      if (!object?.visible) continue;

      _mesh.matrixWorld = object.matrix;

      _mesh.raycast(raycaster, _intersections);

      for (const intersect of _intersections) {
        intersect.instanceId = object.id;
        intersect.object = this;
        result.push(intersect);
      }

      _intersections.length = 0;
    }

    _instancesIntersected.length = 0;

    result.sort(ascSortIntersection);

    raycaster.ray = originalRay;
    raycaster.near = originalNear;
    raycaster.far = originalFar;

    function getObject(index: number): InstancedEntity {
      return instancesToCheck[index] as InstancedEntity;
    }

    function getObjectByIndex(index: number): InstancedEntity {
      const objectIndex = (instancesToCheck as Uint32Array)[index];
      return objectIndex <= instancesCount ? instances[objectIndex] : undefined;
    }
  }

  protected frustumCulling(camera: Camera): void {
    const sortObjects = this.sortObjects;
    const array = this.instanceIndex.array;

    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);

    if (sortObjects) {
      _invMatrixWorld.copy(this.matrixWorld).invert();
      _cameraPos.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_invMatrixWorld);
      _forward.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(_invMatrixWorld);
    }

    if (this.bvh) this.BVHCulling();
    else this.linearCulling();

    if (sortObjects) {
      const customSort = this.customSort;

      if (customSort === null) {
        _renderList.list.sort(!(this.material as Material)?.transparent ? sortOpaque : sortTransparent);
      } else {
        customSort(_renderList.list, camera);
      }

      const list = _renderList.list;
      for (let i = 0, l = list.length; i < l; i++) {
        array[i] = list[i].index;
      }

      this._count = list.length;
      _renderList.reset();
    }
  }

  protected BVHCulling(): void {
    const array = this.instanceIndex.array;
    const instancesCount = this.instancesCount;
    const sortObjects = this.sortObjects;
    let count = 0;

    this.bvh.frustumCulling(_projScreenMatrix, _frustumResult);

    for (const object of _frustumResult) {
      const index = object.id;

      if (index < instancesCount && object.visible) {
        if (sortObjects) {
          const depth = _temp.subVectors(object.position, _cameraPos).dot(_forward); // this can be less precise than sphere.center
          _renderList.push(depth, index);
        } else {
          array[count++] = index;
        }
      }
    }

    this._count = count;
    _frustumResult.length = 0;
  }

  protected linearCulling(): void {
    const array = this.instanceIndex.array;
    const bSphere = this.geometry.boundingSphere;
    const radius = bSphere.radius;
    const center = bSphere.center;
    const instances = this.instances;
    const instancesCount = this.instancesCount;
    const geometryCentered = center.x === 0 && center.y === 0 && center.z === 0;
    const sortObjects = this.sortObjects;
    let count = 0;

    _frustum.setFromProjectionMatrix(_projScreenMatrix);

    for (let i = 0, l = instancesCount; i < l; i++) {
      const instance = instances[i];
      if (!instance.visible) continue;

      if (geometryCentered) _sphere.center.copy(instance.position);
      else _sphere.center.copy(center).applyMatrix4(instance.matrix);
      _sphere.radius = radius * getMax(instance.scale);

      if (_frustum.intersectsSphere(_sphere)) {
        if (sortObjects) {
          const depth = _temp.subVectors(_sphere.center, _cameraPos).dot(_forward);
          _renderList.push(depth, instance.id);
        } else {
          array[count++] = instance.id;
        }
      }
    }

    this._count = count;

    function getMax(scale: Vector3): number {
      if (scale.x > scale.y) return scale.x > scale.z ? scale.x : scale.z;
      return scale.y > scale.z ? scale.y : scale.z;
    }
  }

  // #region three.js InstancedMesh method

  public computeBoundingBox(): void {
    const geometry = this.geometry;
    const count = this.instancesCount;
    const instances = this.instances;

    if (this.boundingBox === null) this.boundingBox = new Box3();
    if (geometry.boundingBox === null) geometry.computeBoundingBox();

    const geoBoundingBox = geometry.boundingBox;
    const boundingBox = this.boundingBox;

    boundingBox.makeEmpty();

    for (let i = 0; i < count; i++) {
      _box3.copy(geoBoundingBox).applyMatrix4(instances[i].matrix);
      boundingBox.union(_box3);
    }
  }

  public computeBoundingSphere(): void {
    const geometry = this.geometry;
    const count = this.instancesCount;
    const instances = this.instances;

    if (this.boundingSphere === null) this.boundingSphere = new Sphere();
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();

    const geoBoundingSphere = geometry.boundingSphere;
    const boundingSphere = this.boundingSphere;

    boundingSphere.makeEmpty();

    for (let i = 0; i < count; i++) {
      _sphere.copy(geoBoundingSphere).applyMatrix4(instances[i].matrix);
      boundingSphere.union(_sphere);
    }
  }

  public override copy(source: InstancedMesh2, recursive?: boolean): this {
    super.copy(source, recursive);

    (this.instanceIndex as any).copy(source.instanceIndex); // TODO fix d.ts
    this.instanceTexture = source.instanceTexture.clone();

    if (source.morphTexture !== null) this.morphTexture = source.morphTexture.clone();

    //TODO copy uniform?

    this.instancesCount = source.instancesCount;
    this._count = source._maxCount;
    this._maxCount = source._maxCount;

    if (source.boundingBox !== null) this.boundingBox = source.boundingBox.clone();
    if (source.boundingSphere !== null) this.boundingSphere = source.boundingSphere.clone();

    return this;
  }

  public getMorphAt(index: number, object: Mesh): void {
    const objectInfluences = object.morphTargetInfluences;
    const array = this.morphTexture.source.data.data;
    const len = objectInfluences.length + 1; // All influences + the baseInfluenceSum
    const dataIndex = index * len + 1; // Skip the baseInfluenceSum at the beginning

    for (let i = 0; i < objectInfluences.length; i++) {
      objectInfluences[i] = array[dataIndex + i];
    }
  }

  public setMorphAt(index: number, object: Mesh): void {
    const objectInfluences = object.morphTargetInfluences;
    const len = objectInfluences.length + 1; // morphBaseInfluence + all influences

    if (this.morphTexture === null) {
      this.morphTexture = new DataTexture(new Float32Array(len * this._maxCount), len, this._maxCount, RedFormat, FloatType);
    }

    const array = this.morphTexture.source.data.data;
    let morphInfluencesSum = 0;

    for (let i = 0; i < objectInfluences.length; i++) {
      morphInfluencesSum += objectInfluences[i];
    }

    const morphBaseInfluence = this.geometry.morphTargetsRelative ? 1 : 1 - morphInfluencesSum;
    const dataIndex = len * index;
    array[dataIndex] = morphBaseInfluence;
    array.set(objectInfluences, dataIndex + 1);
  }

  public dispose(): this {
    this.dispatchEvent<any>({ type: 'dispose' });

    this.instanceTexture.dispose();
    //TODO dispose uniform

    if (this.morphTexture !== null) {
      this.morphTexture.dispose();
      this.morphTexture = null;
    }

    return this;
  }

  //#endregion

}

const _box3 = new Box3();
const _sphere = new Sphere();
const _frustum = new Frustum();
const _projScreenMatrix = new Matrix4();
const _frustumResult: InstancedEntity[] = [];
const _instancesIntersected: InstancedEntity[] = [];
const _intersections: Intersection[] = [];
const _mesh = new Mesh();
const _ray = new Ray();
const _direction = new Vector3();
const _worldScale = new Vector3();
const _invMatrixWorld = new Matrix4();
const _renderList = new InstancedRenderList();
const _forward = new Vector3();
const _cameraPos = new Vector3();
const _temp = new Vector3();

function ascSortIntersection(a: Intersection, b: Intersection): number {
  return a.distance - b.distance;
}

function sortOpaque(a: InstancedRenderItem, b: InstancedRenderItem) {
  return a.depth - b.depth;
}

function sortTransparent(a: InstancedRenderItem, b: InstancedRenderItem) {
  return b.depth - a.depth;
}

// https://github.com/mrdoob/three.js/blob/dev/src/math/Matrix4.js#L732
// extracting the scale directly is ~3x faster than using "decompose"
function extractMatrixScale(matrix, target) {
  const te = matrix.elements;
  const sx = target.set(te[0], te[1], te[2]).length();
  const sy = target.set(te[4], te[5], te[6]).length();
  const sz = target.set(te[8], te[9], te[10]).length();
  return target.set(sx, sy, sz);
}
