import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import Editor from '@monaco-editor/react';

const DEFAULT_SCRIPT = `// Modify CAD script directly or use the AI assistant to code for you
// It's helpful to use the assistant to get started and edit from there
// Assistant is good at iterating on an object, similar to how you would use a CAD program
// You can click on faces to guide the assistant
// When coding directly, use javascript syntax and return a single manifold object

const {cube, cylinder, union, subtract} = Manifold;

// Control the roundness of circular features
// 256 makes flat faces on round features indistinguishable
const n = 256;

// Create a flat plate 90 mm x 35 mm x 5 mm thick
const plateThickness = 5;
const plateLength = 35;
const plateWidth = 35;
var plate = cube([plateLength, plateWidth, plateThickness], true);

// Here is an example of how to add bosses to a plate
// Define boss properties
const bossDiameter = 12.5;
const bossHeight = 22;
const bossSeparation = 22;

// Create two bosses
const boss1 = cylinder(bossHeight, bossDiameter / 2, bossDiameter / 2, n, true)
  .translate([-bossSeparation / 2, 0, bossHeight / 2 + plateThickness/2]); 

const boss2 = cylinder(bossHeight, bossDiameter / 2, bossDiameter / 2, n, true)
    .translate([bossSeparation / 2, 0, bossHeight / 2 + plateThickness/2]); 

// Here is an example of how to cut holes in bosses
// Create holes
const holeDiameter = 4;
const holeDepth = bossHeight + plateThickness;
const hole1 = cylinder(holeDepth, holeDiameter / 2, holeDiameter / 2, n, true)
  .translate([-bossSeparation / 2, 0, holeDepth / 2]);

const hole2 = cylinder(holeDepth, holeDiameter / 2, holeDiameter / 2, n, true)
  .translate([bossSeparation / 2, 0, holeDepth / 2]);

// Cut them from the shape
const modifiedBoss1 = boss1.subtract(hole1);
const modifiedBoss2 = boss2.subtract(hole2);
plate = plate.subtract(hole1);
plate = plate.subtract(hole2);

// Here is an example of how to create a slot shape
// Create slot shape
const slotWidth = 9;
const slotLength = 15;
const slotCube = cube([slotWidth, slotLength, plateThickness], true);
const slotCyl1 = cylinder(plateThickness, slotWidth / 2, slotWidth / 2, n, true).translate([0, slotLength/2, 0]);
const slotCyl2 = cylinder(plateThickness, slotWidth / 2, slotWidth / 2, n, true).translate([0, -slotLength/2, 0]);

// Cut the slot from the plate
plate = plate.subtract(union([slotCube, slotCyl1, slotCyl2]));

// Here is an example of how to round the corners of a plate, or "fillet" the corners 
const filletRad = 2.5
// First remove material from corners using cubes
const cornerCube1 = cube([filletRad * 2, filletRad * 2, plateThickness], true).translate([-plateLength / 2, plateWidth/2, 0]);
const cornerCube2 = cube([filletRad * 2, filletRad * 2, plateThickness], true).translate([plateLength / 2, plateWidth/2, 0]);
const cornerCube3 = cube([filletRad * 2, filletRad * 2, plateThickness], true).translate([-plateLength / 2, -plateWidth/2, 0]);
const cornerCube4 = cube([filletRad * 2, filletRad * 2, plateThickness], true).translate([plateLength / 2, -plateWidth/2, 0]);
plate = plate.subtract(union([cornerCube1, cornerCube2, cornerCube3, cornerCube4]));

// Then rebuild corners using cylinders
const cornerCyl1 = cylinder(plateThickness, filletRad, filletRad, n, true).translate([-plateLength / 2 + filletRad, plateWidth/2-filletRad, 0]);
const cornerCyl2 = cylinder(plateThickness, filletRad, filletRad, n, true).translate([plateLength / 2 - filletRad, plateWidth/2-filletRad, 0]);
const cornerCyl3 = cylinder(plateThickness, filletRad, filletRad, n, true).translate([-plateLength / 2 + filletRad, -plateWidth/2+filletRad, 0]);
const cornerCyl4 = cylinder(plateThickness, filletRad, filletRad, n, true).translate([plateLength / 2 - filletRad, -plateWidth/2+filletRad, 0]);

// Combine the shapes
plate = union([plate, cornerCyl1, cornerCyl2, cornerCyl3, cornerCyl4]);
// Fillet is complete

// Here is an example of how to combine multiple shapes in to one object
var plateWithBosses = union([plate, modifiedBoss1, modifiedBoss2])

// Here is an example of how to cut a flat in a boss
// Create a flat cube features between the bosses
const flat = cube([12, 30, 22], true).translate([0, 0, (11+plateThickness/2)]);

// Cut it from the shape
var plateWithBosses = plateWithBosses.subtract(flat);

// Here is an example of how to create counter bores in bosses
const cboreDiameter = 7;
const webLeft = 2;
const cboreDepth = bossHeight + plateThickness - webLeft;
const cbore1 = cylinder(cboreDepth, cboreDiameter / 2, cboreDiameter / 2, n, true)
    .translate([bossSeparation / 2, 0, cboreDepth / 2 - plateThickness]);
const cbore2 = cylinder(cboreDepth, cboreDiameter / 2, cboreDiameter / 2, n, true)
    .translate([-bossSeparation / 2, 0, cboreDepth / 2 - plateThickness]);

var result = plateWithBosses.subtract(cbore1);
result = result.subtract(cbore2);

return result;`;

const CodeEditor = forwardRef(({ 
  onExecute, 
  onCodeChange, 
  onUndo, 
  onRedo, 
  canUndo, 
  canRedo,
  isMobile
}, ref) => {
  const [editorValue, setEditorValue] = useState(DEFAULT_SCRIPT);
  const editorRef = useRef();
  const historyTimeoutRef = useRef(null);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    getContent: () => editorValue,
    loadContent: (content, message = 'File loaded', skipHistory = false) => {
      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
      }
      setEditorValue(content);
      onExecute(content, true);
      
      // Only save to history if not using undo/redo buttons
      if (!skipHistory) {
        onCodeChange?.(content, message);
      }
    }
  }));

  const handleEditorChange = (newValue) => {
    setEditorValue(newValue);
    onExecute(newValue);
    
    if (historyTimeoutRef.current) {
      clearTimeout(historyTimeoutRef.current);
    }
    
    historyTimeoutRef.current = setTimeout(() => {
      onCodeChange?.(newValue, 'Manual edit');
    }, 1000);
  };

  const handleUndo = () => {
    const code = onUndo?.();
    if (code) {
      setEditorValue(code);
    }
  };

  const handleRedo = () => {
    const code = onRedo?.();
    if (code) {
      setEditorValue(code);
    }
  };

  const editorDidMount = (editor) => {
    editorRef.current = editor;
    editor.focus();
    onExecute(DEFAULT_SCRIPT, true);
    onCodeChange?.(DEFAULT_SCRIPT, 'Initial script');
  };

  useEffect(() => {
    return () => {
      if (historyTimeoutRef.current) {
        clearTimeout(historyTimeoutRef.current);
      }
    };
  }, []);

  const options = {
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'off',
    scrollBeyondLastLine: false,
    fontSize: isMobile ? 16 : 12,
    renderLineHighlight: 'all',
    formatOnPaste: true,
    contextmenu: true,
    wordWrap: 'on',
    quickSuggestions: false,
    domReadOnly: false,
    readOnly: false,
  };

  return (
    <div className="relative flex flex-col h-full bg-gray-900">
      <div className="flex-1 min-h-0">
        <Editor
          width="100%"
          height="100%"
          language="javascript"
          theme="vs-dark"
          value={editorValue}
          options={options}
          onChange={handleEditorChange}
          onMount={editorDidMount}
        />
      </div>
    </div>
  );
});

export default CodeEditor;