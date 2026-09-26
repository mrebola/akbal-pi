varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vNormalWorld;   
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;

uniform float uTime;

mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

void setLayers(vec3 p){
    float t = uTime;

    vec3 p1 = p;
    p1.yz = rot(t) * p1.yz;
    vLayer0 = p1;

    p1 = p;
    p1.zx = rot(t + 2.094) * p1.zx;
    vLayer1 = p1;

    p1 = p;
    p1.xy = rot(t - 4.188) * p1.xy;
    vLayer2 = p1;
}

void main(){
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;

    
    vNormalView = normalize(normalMatrix * normal);

    
    vNormalWorld = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

    
    setLayers(normalize(normal));

    gl_Position = projectionMatrix * viewMatrix * world;
}